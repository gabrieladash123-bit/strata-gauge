import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { keccak256 } from "viem";
import {
  canonical, client, expectedState, finalized, getState, makePlan, rpc, sha256, sourcePath, verifyReceipt,
} from "./proof-lib.mjs";

assert.equal(await rpc("eth_chainId"), "0xf22f", "StudioNet only");
assert.equal(BigInt(await rpc("eth_gasPrice")), 0n, "Expected a zero-gas-price StudioNet");

const source = await readFile(sourcePath);
const folder = "proofs/work";
await mkdir(folder, { recursive: true });
const journal = join(folder, "proof.json");
const resume = process.argv.includes("--resume");
const previous = resume ? JSON.parse(await readFile(journal)) : null;
if (!resume) {
  try {
    await access(journal);
    throw new Error("A proof journal already exists. Use --resume after checking its transaction hashes.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const revision = previous?.revision ?? process.env.STRATA_PROOF_REVISION ?? process.env.GITHUB_SHA;
const repository = previous?.repository ?? process.env.STRATA_PROOF_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
const plan = await makePlan(repository, revision);
const encoded = Buffer.from(JSON.stringify(canonical(plan)));
const study = sha256(encoded);

const authors = [createAccount(), createAccount()];
assert.notEqual(authors[0].address, authors[1].address);
const ledger = previous ?? {
  network: "studionet", chain_id: 61999, repository, revision, study, source_sha256: sha256(source),
  account_addresses: [], transactions: [],
};
assert.equal(ledger.chain_id, studionet.id);
assert.equal(ledger.study, study);
assert.equal(ledger.source_sha256, sha256(source));
ledger.account_addresses.push(...authors.map(author => author.address));
const save = () => writeFile(journal, JSON.stringify(ledger, null, 2) + "\n");
await save();
for (const { address } of authors) {
  assert.equal(BigInt(await rpc("eth_getBalance", [address, "latest"])), 0n, "Use disposable StudioNet accounts");
  await rpc("sim_fundAccount", [address, 1e18]);
  assert(BigInt(await rpc("eth_getBalance", [address, "latest"])) >= 1_000_000_000_000_000_000n);
}
console.log("Funded disposable callers with StudioNet test credits", ...ledger.account_addresses);

async function send(label, actor, method, args = [], expectedError = null) {
  const author = authors[actor];
  const deploy = method === undefined;
  let entry = ledger.transactions.find(tx => tx.label === label);
  const alreadySubmitted = Boolean(entry?.hash || entry?.evm_hash);
  if (entry?.evm_hash && !entry.hash) {
    const receipt = await rpc("eth_getTransactionReceipt", [entry.evm_hash]);
    assert.equal(receipt?.status, "0x1", `Check the previously signed transaction ${entry.evm_hash}`);
    entry.hash = entry.evm_hash;
  }
  if (!alreadySubmitted) {
    if (!entry) {
      entry = { label };
      ledger.transactions.push(entry);
    }
    Object.assign(entry, { sender: author.address, expected_error: expectedError });
    const signer = {
      ...author,
      async signTransaction(transaction) {
        assert.equal(transaction.chainId, studionet.id);
        assert(BigInt(transaction.value ?? 0) <= 100_000_000_000_000_000n, "Test fee limit exceeded");
        const signed = await author.signTransaction(transaction);
        entry.evm_hash = keccak256(signed);
        await save();
        return signed;
      },
    };
    const sender = createClient({ chain: studionet, account: signer });
    const estimate = await sender.estimateTransactionFees({
      leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n, rotations: [0],
    });
    const fees = { distribution: estimate.distribution, feeValue: estimate.feeValue };
    assert(fees.feeValue <= 100_000_000_000_000_000n, "Test fee limit exceeded");
    entry.test_fee_deposit_wei = fees.feeValue.toString();
    await save();
    const options = { fees, consensusMaxRotations: 0 };
    const submit = () => deploy
      ? sender.deployContract({ ...options, code: source, args })
      : sender.writeContract({ ...options, address: ledger.contract, functionName: method, args, value: 0n });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        entry.hash = await submit();
        break;
      } catch (error) {
        if (entry.evm_hash || attempt === 2 || !/database|network|timeout|fetch failed/i.test(String(error))) {
          throw error;
        }
        await sleep(5_000 * (attempt + 1));
      }
    }
    assert.match(entry.hash, /^0x[\da-f]{64}$/i);
    await save();
    console.log("Submitted", label, entry.hash);
  }
  const receipt = await finalized(entry.hash);
  if (deploy) {
    ledger.contract = receipt.to_address ?? receipt.recipient;
    assert.match(ledger.contract, /^0x[\da-f]{40}$/i);
    assert.deepEqual(Buffer.from(receipt.data.contract_code, "base64"), source);
    assert.equal(await client.getContractCode(ledger.contract), source.toString("utf8"));
  }
  Object.assign(entry, verifyReceipt(receipt, entry.hash, ledger.contract, entry.sender, expectedError));
  console.log("Finalized", label, entry.execution, `${entry.agree}/${entry.votes}`);
  await save();
  return !alreadySubmitted;
}

const state = async slots => assert.deepEqual(await getState(ledger.contract, study), expectedState(plan, slots));
await send("deploy", 0);
if (await send("create-study", 0, "create", [encoded])) await state([]);
if (await send("record-burst", 1, "record", [study, 1])) await state([1]);
if (await send("record-standard", 0, "record", [study, 0])) await state([0, 1]);
await send("reject-duplicate", 1, "record", [study, 0], "Cohort already recorded");
ledger.readback = await getState(ledger.contract, study);
assert.deepEqual(ledger.readback, expectedState(plan, [0, 1]));
await save();
console.log("Verified", ledger.contract, ledger.study);
