import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildCatalog,
  catalogLevels,
  parseLevels,
  resolveLevels,
  resolveSecret,
  normalizeBaseURL,
} from "../src/index.js"

test("parseLevels: valid levels 形式", () => {
  assert.deepEqual(
    parseLevels('{"error":{"message":"level \\"x\\" not supported, valid levels: none, low, high, max"}}'),
    ["none", "low", "high", "max"],
  )
})

test("parseLevels: expected one of 形式（NVIDIA）", () => {
  assert.deepEqual(
    parseLevels(
      "unknown variant `bogus`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` at line 1 column 143",
    ),
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  )
})

test("parseLevels: 没有回显时返回 null", () => {
  assert.equal(parseLevels("请求参数不被上游接受，请检查参数后重试"), null)
  assert.equal(parseLevels('{"error":{"type":"invalid_request_error"}}'), null)
})

test("parseLevels: 不会把 type 之类的字段吞进档位", () => {
  const parsed = parseLevels('valid levels: low, high, max","type":"invalid_request_error"}')
  assert.deepEqual(parsed, ["low", "high", "max"])
})

test("resolveSecret: 明文 / env / 命令", () => {
  assert.equal(resolveSecret("abc"), "abc")
  process.env.EFFORT_TEST_KEY = "from-env"
  assert.equal(resolveSecret("{env:EFFORT_TEST_KEY}"), "from-env")
  assert.equal(resolveSecret("{env:NOT_SET_KEY}"), undefined)
  assert.equal(
    resolveSecret("!node -e \"process.stdout.write('from-cmd')\"", {
      exec: (command) => command.includes("node") ? "from-cmd" : "",
    }),
    "from-cmd",
  )
})

test("normalizeBaseURL: 去掉尾部斜杠与 /chat/completions，保留 /v1", () => {
  assert.equal(normalizeBaseURL("https://api.x/v1/"), "https://api.x/v1")
  assert.equal(normalizeBaseURL("https://api.x/v1/chat/completions"), "https://api.x/v1")
})

test("buildCatalog + catalogLevels: 只认 provider 自己或 canonical owner", () => {
  const json = {
    vendor: {
      models: {
        "model-a": {
          reasoning_options: [{ type: "effort", values: ["low", "max"] }],
          canonical_model_id: "vendor/model-a",
        },
        "model-b": {
          reasoning_options: [{ type: "effort", values: ["medium"] }],
          canonical_model_id: "other/model-b",
        },
      },
    },
    reseller: {
      models: {
        "model-a": {
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
          canonical_model_id: "vendor/model-a",
        },
      },
    },
  }
  const catalog = { at: Date.now(), ...buildCatalog(json) }
  // 同 provider 的声明优先
  assert.deepEqual(catalogLevels(catalog, "vendor", "model-a"), ["low", "max"])
  assert.deepEqual(catalogLevels(catalog, "reseller", "model-a"), ["low", "medium", "high", "max"])
  // 没有该 provider 的条目时，用 canonical owner 的声明
  assert.deepEqual(catalogLevels(catalog, "unknown-gateway", "model-a"), ["low", "max"])
  // canonical 指向别处的模型不会被当成 owner —— 不跨 provider 猜
  assert.equal(catalogLevels(catalog, "unknown-gateway", "model-b"), undefined)
})

test("resolveLevels: 探针优先于目录", () => {
  const catalog = { at: 0, owner: { m: ["low"] }, byProvider: {} }
  assert.deepEqual(
    resolveLevels({ probe: { levels: ["high"], source: "validated", at: 0 }, catalog, providerID: "p", modelID: "m" }),
    ["high"],
  )
  assert.deepEqual(
    resolveLevels({ probe: { levels: null, source: "no-validation", at: 0 }, catalog, providerID: "p", modelID: "m" }),
    ["low"],
  )
  assert.equal(resolveLevels({ probe: { levels: null, source: "error", at: 0 }, providerID: "p", modelID: "m" }), undefined)
})