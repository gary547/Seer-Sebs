import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyKeyword, deriveBrandTokens } from "./brand-classifier.ts";

Deno.test("deriveBrandTokens - multi-word company + domain", () => {
  const t = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: "https://www.nobraineragency.com/",
    domainNormalised: "nobraineragency.com",
  });
  // "agency" is a stop word and dropped from tokens; "no" < 3 chars.
  assertEquals(t.tokens.includes("brainer"), true);
  assertEquals(t.tokens.includes("nobraineragency"), true);
  assertEquals(t.concatenations.includes("nobrainer"), true);
  assertEquals(t.concatenations.includes("nobraineragency"), true);
  // splits reconstruct "no brainer agency" from the domain label
  assertEquals(t.splits.some((s) => s.startsWith("no brainer")), true);
});

Deno.test("classifyKeyword - whole-token branded", () => {
  const tokens = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
  });
  const v = classifyKeyword("no brainer seo", tokens);
  assertEquals(v.decision, "branded");
  if (v.decision === "branded") assertEquals(v.confidence, 0.95);
});

Deno.test("classifyKeyword - concatenation branded", () => {
  const tokens = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
  });
  const v = classifyKeyword("nobrainer reviews", tokens);
  assertEquals(v.decision, "branded");
});

Deno.test("classifyKeyword - clear non-branded", () => {
  const tokens = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
  });
  const v = classifyKeyword("seo services london", tokens);
  assertEquals(v.decision, "non_branded");
  if (v.decision === "non_branded") assertEquals(v.confidence, 0.9);
});

Deno.test("classifyKeyword - fuzzy uncertain", () => {
  const tokens = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
  });
  const v = classifyKeyword("brainar training", tokens);
  assertEquals(v.decision, "uncertain");
});

Deno.test("classifyKeyword - single-word company with extraBrandTerms", () => {
  const tokens = deriveBrandTokens({
    companyName: "Argos",
    domain: null,
    domainNormalised: "argos.co.uk",
    extraBrandTerms: ["habitat"],
  });
  assertEquals(tokens.tokens.includes("argos"), true);
  assertEquals(tokens.tokens.includes("habitat"), true);
  const v = classifyKeyword("habitat sofa", tokens);
  assertEquals(v.decision, "branded");
});

Deno.test("classifyKeyword - empty inputs default non-branded", () => {
  const tokens = deriveBrandTokens({
    companyName: null,
    domain: null,
    domainNormalised: null,
  });
  const v = classifyKeyword("anything at all", tokens);
  assertEquals(v.decision, "non_branded");
});

Deno.test("classifyKeyword - domain-only fallback", () => {
  const tokens = deriveBrandTokens({
    companyName: null,
    domain: null,
    domainNormalised: "acmerockets.io",
  });
  assertEquals(tokens.tokens.includes("acmerockets"), true);
  const v = classifyKeyword("acmerockets discount", tokens);
  assertEquals(v.decision, "branded");
});

Deno.test("classifyKeyword - explicit short term (AO) matches word-boundary, not substring", () => {

  const tokens = deriveBrandTokens({
    companyName: "AO",
    domain: null,
    domainNormalised: "ao.com",
    explicitTerms: ["ao", "ao.com"],
  });
  assertEquals(tokens.explicit.includes("ao"), true);
  // "ao.com" is normalised to "ao com" (dot -> space); both survive as explicit tokens.
  assertEquals(tokens.explicit.includes("ao com"), true);

  for (const kw of ["ao", "ao tv", "ao.com", "ao washing machine", "buy from ao"]) {
    const v = classifyKeyword(kw, tokens);
    assertEquals(v.decision, "branded", `expected "${kw}" branded`);
  }
  for (const kw of ["chaos", "cameo", "halo", "cardboard"]) {
    const v = classifyKeyword(kw, tokens);
    assertEquals(v.decision, "non_branded", `expected "${kw}" non_branded`);
  }
});

Deno.test("classifyKeyword - explicit + derived union", () => {
  const tokens = deriveBrandTokens({
    companyName: "AO World",
    domain: null,
    domainNormalised: "ao.com",
    explicitTerms: ["ao", "ao.com"],
  });
  // Derived path still catches "world" (>=3 chars from company name).
  assertEquals(tokens.tokens.includes("world"), true);
  assertEquals(classifyKeyword("world reviews", tokens).decision, "branded");
  // Explicit path catches "ao dishwasher".
  assertEquals(classifyKeyword("ao dishwasher", tokens).decision, "branded");
});

Deno.test("deriveBrandTokens - empty explicitTerms is a regression-safe no-op", () => {
  const withEmpty = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
    explicitTerms: [],
  });
  const without = deriveBrandTokens({
    companyName: "No Brainer Agency",
    domain: null,
    domainNormalised: "nobraineragency.com",
  });
  assertEquals(withEmpty.tokens.sort(), without.tokens.sort());
  assertEquals(withEmpty.concatenations.sort(), without.concatenations.sort());
  assertEquals(withEmpty.splits.sort(), without.splits.sort());
  assertEquals(withEmpty.explicit, []);
});

Deno.test("classifyKeyword - explicit-only client (no company/domain)", () => {
  const tokens = deriveBrandTokens({
    companyName: null,
    domain: null,
    domainNormalised: null,
    explicitTerms: ["ao"],
  });
  assertEquals(classifyKeyword("ao dishwasher", tokens).decision, "branded");
  assertEquals(classifyKeyword("dishwasher deals", tokens).decision, "non_branded");
});

Deno.test("classifyKeyword - punctuated explicit term matches normalised keyword", () => {
  const tokens = deriveBrandTokens({
    companyName: "AO",
    domain: null,
    domainNormalised: "ao.com",
    explicitTerms: ["ao.com"],
  });
  // norm("ao.com") -> "ao com" — stored as a single explicit phrase.
  assertEquals(tokens.explicit.includes("ao com"), true);
  for (const kw of ["ao.com", "www.ao.com", "ao .com", "visit ao.com today"]) {
    assertEquals(classifyKeyword(kw, tokens).decision, "branded", `expected "${kw}" branded`);
  }
  // Word-boundary safety.
  for (const kw of ["aotv", "chaos tv"]) {
    // "aotv" has no boundary; "chaos tv" doesn't contain "ao" as a whole token.
    const v = classifyKeyword(kw, tokens);
    assertEquals(v.decision !== "branded", true, `expected "${kw}" not branded, got ${v.decision}`);
  }
});

Deno.test("classifyKeyword - multi-word explicit phrase word-boundary", () => {
  const tokens = deriveBrandTokens({
    companyName: null,
    domain: null,
    domainNormalised: null,
    explicitTerms: ["ao com"],
  });
  assertEquals(classifyKeyword("ao com", tokens).decision, "branded");
  assertEquals(classifyKeyword("visit ao com now", tokens).decision, "branded");
  assertEquals(classifyKeyword("taco moment", tokens).decision, "non_branded");
});

Deno.test("regression - whitelist rules must not become brand vocabulary (filter is at index.ts)", () => {
  // Simulate the FIXED index.ts behaviour: only 'brand'/'own_brand' rules feed
  // explicitTerms. A whitelist rule like "tvs" is filtered out upstream, so
  // deriveBrandTokens never sees it — verify the classifier does not brand
  // generic queries when no such term is present.
  const tokens = deriveBrandTokens({
    companyName: "AO",
    domain: null,
    domainNormalised: "ao.com",
    explicitTerms: ["ao", "ao.com"], // whitelist "tvs" NOT included
  });
  for (const kw of ["tvs", "lg tvs", "smart tvs", "aol tvs"]) {
    const v = classifyKeyword(kw, tokens);
    assertEquals(v.decision, "non_branded", `expected "${kw}" non_branded, got ${v.decision}`);
  }
});


