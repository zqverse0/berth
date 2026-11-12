import assert from "node:assert/strict"
import test from "node:test"

import { splitAnswerAndSources } from "../../private/core/sources.js"
import { fixtures } from "./fake.mjs"

for (const item of fixtures("split"))
  test(`split: ${item.name}`, () => {
    const [answer, sources] = splitAnswerAndSources(item.text)
    assert.equal(answer, item.answer)
    assert.deepEqual(sources, item.sources)
  })
