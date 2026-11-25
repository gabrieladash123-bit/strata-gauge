import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  canonical, client, expectedState, finalized, getState, makePlan, rpc, sha256, sourcePath, verifyReceipt,
} from "./proof-lib.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use the disposable StudioNet workflow");
assert.equal(await rpc("eth_chainId"), "0xf22f", "StudioNet only");
assert.equal(BigInt(await rpc("eth_gasPrice")), 0n, "Expected a zero-gas-price StudioNet");

const source = await readFile(sourcePath);
const schema = await client.getContractSchemaForCode(source);
assert(schema && typeof schema === "object", "Hosted schema preflight failed");
const revision = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const plan = await makePlan(repository, revision);
const encoded = Buffer.from(JSON.stringify(canonical(plan)));
const study = sha256(encoded);
const password = randomBytes(24).toString("hex");
const cli = process.env.STRATA_CLI_PATH;
assert(cli, "Missing pinned CLI path");
const folder = "proofs/work";
await mkdir(folder, { recursive: true });

function runCli(args, onHash) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk.toString()));
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(password + "\n");
    let journalEntry;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      const hash = line.match(/(?:Deployment|Write) Transaction Hash:\s*(0x[\da-f]{64})/i)?.[1];
      if (hash && !journalEntry) {
        console.log("Submitted", args[0], args[2] ?? "", hash);
        journalEntry = Promise.resolve(onHash(hash)).then(() => hash);
        journalEntry.catch(reject);
      }
    });
    const timer = setTimeout(() => child.kill(), 220_000);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      if (journalEntry) resolve(journalEntry);
      else if (code === 0 && !onHash) resolve();
      else reject(new Error(`${args[0]} failed before returning a hash: ${stderr.join("").slice(-1500)}`));
    });
  });
}

async function account(name) {
  await runCli(["account", "create", "--name", name, "--password", password]);
  const metadata = JSON.parse(await readFile(join(homedir(), ".genlayer", "keystores", name + ".json")));
  const address = "0x" + metadata.address.replace(/^0x/, "");
  assert.match(address, /^0x[\da-f]{40}$/i);
  return { name, address };
}

await runCli(["network", "set", "studionet"]);
const authors = [await account("strata-origin"), await account("strata-observer")];
assert.notEqual(authors[0].address, authors[1].address);
const ledger = {
  network: "studionet", chain_id: 61999, repository, revision, study, source_sha256: sha256(source),
  account_addresses: authors.map(author => author.address), transactions: [],
};
const save = async () => writeFile(join(folder, "proof.json"), JSON.stringify(ledger, null, 2) + "\n");

async function send(label, actor, args, expectedError = null) {
  const author = authors[actor];
  await runCli(["account", "use", author.name]);
  const entry = { label, sender: author.address, expected_error: expectedError };
  const hash = await runCli(args, async hashValue => {
    entry.hash = hashValue;
    ledger.transactions.push(entry);
    await save();
  });
  const receipt = await finalized(hash);
  if (label === "deploy") {
    ledger.contract = receipt.to_address ?? receipt.recipient;
    assert.match(ledger.contract, /^0x[\da-f]{40}$/i);
    assert.deepEqual(Buffer.from(receipt.data.contract_code, "base64"), source);
    assert.equal(await client.getContractCode(ledger.contract), source.toString("utf8"));
  }
  Object.assign(entry, verifyReceipt(receipt, hash, ledger.contract, author.address, expectedError));
  console.log("Finalized", label, entry.execution, `${entry.agree}/${entry.votes}`);
  await save();
}

const state = async slots => assert.deepEqual(await getState(ledger.contract, study), expectedState(plan, slots));
await send("deploy", 0, ["deploy", "--contract", sourcePath, "--fee-value", "0"]);
const write = (label, actor, method, args, error) => (
  send(label, actor, ["write", ledger.contract, method, "--fee-value", "0", "--args", ...args], error)
);
await write("create-study", 0, "create", ["b#" + encoded.toString("hex")]);
await state([]);
await write("record-burst", 1, "record", [study, "1"]);
await state([1]);
await write("record-standard", 0, "record", [study, "0"]);
await state([0, 1]);
await write("reject-duplicate", 1, "record", [study, "0"], "Cohort already recorded");
ledger.readback = await getState(ledger.contract, study);
assert.deepEqual(ledger.readback, expectedState(plan, [0, 1]));
await save();
console.log("Verified", ledger.contract, ledger.study);
