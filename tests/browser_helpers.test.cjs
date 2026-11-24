const assert = require("node:assert/strict");
const {test} = require("node:test");
const {waitForDevToolsEndpoint} = require("../tools/check_cover_browser.cjs");

test("browser startup tolerates missing, locked and partially written DevTools files", async () => {
  let attempt = 0;
  const value = await waitForDevToolsEndpoint("fixture", {wait: async () => {}, read: async () => {
    const error = ["ENOENT", "EBUSY", "EPERM"][attempt++];
    if (error) throw Object.assign(new Error(error), {code: error});
    return attempt === 4 ? "12345\n" : "12345\n/devtools/browser/test-id\n";
  }});
  assert.deepEqual(value, {port: 12345, endpoint: "/devtools/browser/test-id"});
  assert.equal(attempt, 5);
});

test("browser startup never accepts a malformed port or injected endpoint", async () => {
  for (const content of ["NaN\n/devtools/browser/test", "99999\n/devtools/browser/test", "12345\nhttp://example.com/"]) {
    await assert.rejects(waitForDevToolsEndpoint("fixture", {attempts: 2, wait: async () => {},
      read: async () => content}), /startup timed out/);
  }
});

test("a stopped browser and unexpected filesystem failures are reported immediately", async () => {
  await assert.rejects(waitForDevToolsEndpoint("fixture", {stopped: () => true}), /exited/);
  await assert.rejects(waitForDevToolsEndpoint("fixture", {read: async () => {
    throw Object.assign(new Error("device failure"), {code: "EIO"});
  }}), /device failure/);
});
