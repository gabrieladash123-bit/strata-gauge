import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const endpoint = "https://studio.genlayer.com/api";
export const client = createClient({ chain: studionet });
export const sourcePath = "contracts/strata_gauge.py";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (typeof value === "bigint") {
    assert(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  }
  return value;
}

export async function rpc(method, params = []) {
  assert([
    "eth_chainId", "eth_gasPrice", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionByHash",
    "eth_sendRawTransaction",
  ].includes(method));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  assert(response.ok, `StudioNet RPC HTTP ${response.status}`);
  const payload = await response.json();
  assert(!payload.error, payload.error?.message);
  return payload.result;
}

export async function finalized(hash) {
  for (let attempt = 0; attempt < 96; attempt++) {
    let receipt;
    try {
      receipt = await rpc("eth_getTransactionByHash", [hash]);
    } catch (error) {
      if (attempt === 95) throw error;
    }
    const status = receipt?.status_name ?? receipt?.status;
    if (status === "FINALIZED") return receipt;
    assert.notEqual(status, "CANCELED", `Canceled ${hash}`);
    await sleep(5_000);
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

export function verifyReceipt(receipt, hash, address, sender, expectedError) {
  const txHash = receipt.hash ?? receipt.tx_id;
  const target = receipt.to_address ?? receipt.recipient;
  const caller = receipt.from_address ?? receipt.sender;
  assert.equal(txHash, hash);
  assert.equal(target.toLowerCase(), address.toLowerCase());
  assert.equal(caller.toLowerCase(), sender.toLowerCase());
  assert.equal(receipt.status_name ?? receipt.status, "FINALIZED");
  assert.equal(receipt.result_name ?? receipt.result, "MAJORITY_AGREE");
  const votes = Object.values(receipt.consensus_data.votes);
  const agree = votes.filter(vote => vote === "agree").length;
  assert(agree > votes.length / 2, "Expected strict validator majority");
  const execution = receipt.consensus_data.leader_receipt[0];
  if (expectedError) {
    assert.equal(execution.execution_result, "ERROR");
    const encoded = Buffer.from(execution.result, "base64");
    assert.equal(encoded[0], 1);
    assert.equal(encoded.subarray(1).toString("utf8"), expectedError);
  } else {
    assert(["SUCCESS", "FINISHED_WITH_RETURN"].includes(execution.execution_result),
      `Unexpected execution result for ${hash}: ${execution.execution_result}`);
  }
  return { hash, status: "FINALIZED", execution: execution.execution_result, agree, votes: votes.length };
}

export async function makePlan(repository, revision) {
  assert.match(repository, /^[\w-]+\/[\w.-]+$/);
  assert.match(revision, /^[a-f0-9]{40}$/);
  const cohorts = await Promise.all(["Standard", "Burst"].map(async name => {
    const path = `fixtures/${name.toLowerCase()}.txt`;
    return {
      name,
      weight: 1,
      source: `${repository}/${revision}/${path}`,
      sha256: sha256(await readFile(path)),
    };
  }));
  return { arm_a: "Quartz", arm_b: "Basalt", outcome: "jobs completed within the latency budget", cohorts };
}

export async function getState(address, study) {
  const read = (functionName, args) => client.readContract({ address, functionName, args }).then(canonical);
  const [state, standard, burst] = await Promise.all([
    read("get_study", [study]),
    read("get_observation", [study, 0]),
    read("get_observation", [study, 1]),
  ]);
  return { state, observations: [standard, burst] };
}

export function expectedState(plan, slots) {
  const counts = [[81, 87, 234, 270], [192, 263, 55, 80]];
  const lines = ["ROW 2 | A 81/87 | B 234/270", "ROW 1 | A 192/263 | B 55/80"];
  const observations = plan.cohorts.map(({ source, sha256: hash }, slot) => (
    slots.includes(slot) ? { source, sha256: hash, row: 2 - slot, line: lines[slot], counts: counts[slot] } : null
  ));
  const result = slots.length === 2 ? {
    finding: "SIMPSON_REVERSAL",
    pooled_counts: [273, 350, 289, 350],
    pooled_difference: { numerator: "-8", denominator: "175" },
    standardized_difference: { numerator: "195689", denominator: "3660960" },
    cohorts: [
      { cohort: "Standard", weight: 1, counts: counts[0], difference: { numerator: "28", denominator: "435" } },
      { cohort: "Burst", weight: 1, counts: counts[1], difference: { numerator: "179", denominator: "4208" } },
    ],
  } : null;
  return { state: canonical({ plan, remaining: 2 - slots.length, result }), observations: canonical(observations) };
}
