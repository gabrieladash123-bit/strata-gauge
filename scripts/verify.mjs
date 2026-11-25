import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonical, client, expectedState, getState, makePlan, rpc, sha256, sourcePath, verifyReceipt,
} from "./proof-lib.mjs";

const ledger = JSON.parse(await readFile(process.argv[2] ?? "proofs/studionet.json"));
assert.equal(await rpc("eth_chainId"), "0xf22f");
const source = await readFile(sourcePath);
assert.equal(sha256(source), ledger.source_sha256);
assert.equal(await client.getContractCode(ledger.contract), source.toString("utf8"));
const plan = await makePlan(ledger.repository, ledger.revision);
assert.equal(sha256(JSON.stringify(canonical(plan))), ledger.study);
assert.deepEqual(ledger.transactions.map(tx => tx.label), [
  "deploy", "create-study", "record-burst", "record-standard", "reject-duplicate",
]);
assert.equal(new Set(ledger.transactions.map(tx => tx.hash)).size, 5);
for (const tx of ledger.transactions) {
  const raw = await rpc("eth_getTransactionByHash", [tx.hash]);
  const expectedError = tx.label === "reject-duplicate" ? "Cohort already recorded" : null;
  verifyReceipt(raw, tx.hash, ledger.contract, tx.sender, expectedError);
  if (tx.label === "deploy") assert.deepEqual(Buffer.from(raw.data.contract_code, "base64"), source);
}
const expected = expectedState(plan, [0, 1]);
assert.deepEqual(await getState(ledger.contract, ledger.study), expected);
assert.deepEqual(ledger.readback, expected);
console.log(`Verified five finalized receipts, deployment source, and exact readback for ${ledger.contract}`);
