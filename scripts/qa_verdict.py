"""Verdict + cited-claim model with a deterministic verification pass.

Facts must cite real bundle ids; inferences must chain to a kept fact. This is
the epistemic guardrail in code: anything ungrounded is dropped, so the verdict
can never carry a hallucinated claim.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Claim:
    text: str
    evidence: list[str] = field(default_factory=list)
    kind: str = "fact"
    supports: list[str] = field(default_factory=list)
    verified: bool = False


def verify(claims: list[Claim], bundle: dict) -> list[Claim]:
    kept_facts = []
    for c in claims:
        if c.kind == "fact" and c.evidence and all(e in bundle for e in c.evidence):
            c.verified = True
            kept_facts.append(c)
    fact_texts = {c.text for c in kept_facts}
    kept = list(kept_facts)
    for c in claims:
        if c.kind == "inference" and any(s in fact_texts for s in c.supports):
            c.verified = True
            kept.append(c)
    order = {id(c): i for i, c in enumerate(claims)}
    kept.sort(key=lambda c: order[id(c)])
    return kept


@dataclass
class Verdict:
    scenario: str
    status: str
    claims: list[Claim] = field(default_factory=list)
    attribution: str = "change"

    def to_json(self) -> dict:
        return {
            "scenario": self.scenario,
            "status": self.status,
            "attribution": self.attribution,
            "claims": [
                {
                    "text": c.text,
                    "kind": c.kind,
                    "evidence": c.evidence,
                    "verified": c.verified,
                }
                for c in self.claims
            ],
        }
