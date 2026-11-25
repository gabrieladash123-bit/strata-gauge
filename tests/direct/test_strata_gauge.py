import hashlib
import json
from fractions import Fraction
from pathlib import Path

import pytest


CONTRACT = "contracts/strata_gauge.py"
FIXTURES = Path("fixtures")
COMMIT = "e" * 40
SCENARIOS = ("standard", "burst")


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy(CONTRACT, sdk_version="v0.2.16")


def plan_data():
    return {
        "arm_a": "Quartz",
        "arm_b": "Basalt",
        "outcome": "jobs completed within the latency budget",
        "cohorts": [
            {
                "name": scenario.title(),
                "source": f"example/strata-gauge/{COMMIT}/fixtures/{scenario}.txt",
                "sha256": hashlib.sha256((FIXTURES / f"{scenario}.txt").read_bytes()).hexdigest(),
                "weight": 1,
            }
            for scenario in SCENARIOS
        ],
    }


def encode(plan, **options):
    return json.dumps(plan, **options).encode()


def configure(vm, *, standard=2, burst=1, replacement_body=None):
    for scenario, row in zip(SCENARIOS, (standard, burst)):
        body = (FIXTURES / f"{scenario}.txt").read_bytes()
        if replacement_body is not None and scenario == "standard":
            body = replacement_body
        vm.mock_web(rf".*/fixtures/{scenario}\.txt$", {"status": 200, "body": body})
        vm.mock_llm(
            rf'.*"cohort":"{scenario.title()}".*',
            json.dumps(row if isinstance(row, dict) else {"row": row}),
        )


def test_permissionless_out_of_order_completion(direct_vm, contract, direct_bob):
    configure(direct_vm)
    plan = plan_data()
    key = contract.create(encode(plan))

    with direct_vm.prank(direct_bob):
        assert contract.record(key, 1) == {"index": 1, "status": "RECORDED"}
    assert contract.get_study(key) == {"plan": plan, "remaining": 1, "result": None}
    assert contract.get_observation(key, 0) is None
    assert contract.get_observation(key, 1)["counts"] == [192, 263, 55, 80]
    assert contract.record(key, 0) == {"index": 0, "status": "COMPLETE"}

    result = contract.get_study(key)["result"]
    assert result["finding"] == "SIMPSON_REVERSAL"
    assert result["pooled_counts"] == [273, 350, 289, 350]
    assert result["pooled_difference"] == {"numerator": "-8", "denominator": "175"}
    expected = ((Fraction(81, 87) - Fraction(234, 270)) + (Fraction(192, 263) - Fraction(55, 80))) / 2
    assert result["standardized_difference"] == {
        "numerator": str(expected.numerator), "denominator": str(expected.denominator),
    }
    assert contract.get_observation(key, 0) == {
        "row": 2,
        "line": "ROW 2 | A 81/87 | B 234/270",
        "counts": [81, 87, 234, 270],
        "source": plan["cohorts"][0]["source"],
        "sha256": plan["cohorts"][0]["sha256"],
    }
    with direct_vm.expect_revert("Cohort already recorded"):
        contract.record(key, 0)


def test_validator_refetches_and_rejects_different_eligible_row(direct_vm, contract):
    configure(direct_vm)
    key = contract.create(encode(plan_data()))
    contract.record(key, 0)
    assert direct_vm.run_validator() is True
    direct_vm.clear_mocks()
    configure(direct_vm, standard=1)
    assert direct_vm.run_validator() is False
    direct_vm.clear_mocks()
    configure(direct_vm, replacement_body=b"ROW 2 | A 1/2 | B 1/3")
    assert direct_vm.run_validator() is False


def test_consensus_selection_is_consequential(direct_vm, contract):
    configure(direct_vm, standard=1)
    key = contract.create(encode(plan_data()))
    contract.record(key, 0)
    contract.record(key, 1)
    assert contract.get_study(key)["result"]["finding"] == "NO_REVERSAL"
    assert contract.get_study(key)["result"]["pooled_counts"] == [242, 350, 295, 350]


def test_unresolved_does_not_consume_slot_and_can_retry(direct_vm, contract):
    configure(direct_vm, standard=0)
    key = contract.create(encode(plan_data()))
    assert contract.record(key, 0) == {"index": 0, "status": "UNRESOLVED"}
    assert contract.get_study(key)["remaining"] == 2
    assert contract.get_observation(key, 0) is None
    direct_vm.clear_mocks()
    configure(direct_vm)
    assert contract.record(key, 0)["status"] == "RECORDED"


@pytest.mark.parametrize("invalid", [{"row": True}, {"row": 15}, {"row": 2, "confidence": 1}])
def test_rejects_invalid_model_output(direct_vm, contract, invalid):
    configure(direct_vm, standard=invalid)
    key = contract.create(encode(plan_data()))
    with direct_vm.expect_revert("Report acquisition or interpretation failed"):
        contract.record(key, 0)
    assert contract.get_study(key)["remaining"] == 2


@pytest.mark.parametrize("body", [
    b"ROW 2 | A 9/8 | B 2/8\n",
    b"ROW 2 | A 0/0 | B 2/8\n",
    b"ROW 2 | A 1/8 | B 2/8\nROW 2 | A 1/8 | B 2/8\n",
    b"ROW 2 | A 1/8 | B 2.0/8\n",
])
def test_structurally_invalid_evidence_reverts(direct_vm, contract, body):
    configure(direct_vm, replacement_body=body)
    plan = plan_data()
    plan["cohorts"][0]["sha256"] = hashlib.sha256(body).hexdigest()
    key = contract.create(encode(plan))
    with direct_vm.expect_revert("Report acquisition or interpretation failed"):
        contract.record(key, 0)


def test_digest_mismatch_reverts(direct_vm, contract):
    configure(direct_vm, replacement_body=b"ROW 2 | A 81/87 | B 0/1\n")
    key = contract.create(encode(plan_data()))
    with direct_vm.expect_revert("Report acquisition or interpretation failed"):
        contract.record(key, 0)
    assert contract.get_observation(key, 0) is None


@pytest.mark.parametrize(("field", "value", "error"), [
    ("weight", True, "Weight must be an integer"),
    ("source", "example/strata-gauge/main/fixtures/standard.txt", "Invalid or duplicate source"),
    ("name", "burst", "Invalid or duplicate cohort name"),
    ("sha256", "ABC", "Invalid or duplicate report digest"),
])
def test_invalid_plan_fields(direct_vm, contract, field, value, error):
    plan = plan_data()
    plan["cohorts"][0][field] = value
    with direct_vm.expect_revert(error):
        contract.create(encode(plan))


def test_canonical_plan_and_range_guards(direct_vm, contract):
    plan = plan_data()
    key = contract.create(encode(plan))
    with direct_vm.expect_revert("Study already exists"):
        contract.create(encode(plan, sort_keys=True, indent=4))
    with direct_vm.expect_revert("Unknown cohort"):
        contract.record(key, 2)
    with direct_vm.expect_revert("Unknown study"):
        contract.record("0" * 64, 0)
