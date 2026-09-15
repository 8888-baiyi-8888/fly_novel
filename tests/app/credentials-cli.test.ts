import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { promptSecret } from "../../src/app/credentials-cli";

test("圆点回显支持粘贴、退格、光标编辑和取消，不泄露输入", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm";
  let displayed = "";
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  const output = Object.assign(new Writable({
    write(chunk, _encoding, callback) { displayed += chunk.toString(); callback(); },
  }), { isTTY: true, columns: 12 });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    const result = promptSecret("Key:");
    input.write("abc");
    assert.ok(displayed.includes("•••"));
    input.write("\x7f");
    assert.ok(displayed.endsWith("\r\x1b[2K••\r\x1b[2C"), JSON.stringify(displayed));
    input.write("\x1b[D");
    input.write("Z");
    input.write("\r");
    assert.equal(await result, "aZb");
    assert.ok(!displayed.includes("abc"));
    assert.ok(!displayed.includes("Z"));
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("keypress"), 0);

    displayed = "";
    const pasted = promptSecret("Key:");
    input.write("x".repeat(100));
    assert.ok(!displayed.includes("x"));
    assert.ok(!displayed.includes("•".repeat(12)));
    input.write("\r");
    assert.equal(await pasted, "x".repeat(100));

    const cancelled = promptSecret("Key:");
    const rejection = assert.rejects(cancelled, /已取消/);
    input.write("private");
    input.write("\x03");
    await rejection;
    assert.ok(!displayed.includes("private"));
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("keypress"), 0);
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stdout", stdoutDescriptor);
    input.destroy();
    output.destroy();
  }
});
