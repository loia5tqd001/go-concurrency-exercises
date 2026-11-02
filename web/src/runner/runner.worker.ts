// The runner worker runs one linked program. It is created per run and
// terminated afterwards, so Stop can always kill it, even mid-loop.
import { runBinary, type SourceFile } from "./toolchain.ts";

// Matches the Go Playground's cap; past this a runaway print loop only
// makes the page slow.
const outputLimit = 4 << 20;

self.onmessage = async (e: MessageEvent) => {
  const { binary, argv, dir, files } = e.data as { binary: Uint8Array; argv: string[]; dir: string; files: SourceFile[] };

  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  let buffered = "";
  let bufferedFd: 1 | 2 = 1;
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total = 0;
  let truncated = false;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (buffered) self.postMessage({ type: "output", fd: bufferedFd, text: buffered });
    buffered = "";
    lastFlush = performance.now();
  };

  const onOutput = (fd: 1 | 2, bytes: Uint8Array) => {
    if (truncated) return;
    total += bytes.length;
    if (total > outputLimit) {
      truncated = true;
      flush();
      self.postMessage({ type: "output", fd: 2, text: "\n[output truncated after 4 MB]\n" });
      return;
    }
    if (fd !== bufferedFd) flush();
    bufferedFd = fd;
    buffered += decoders[fd].decode(bytes, { stream: true });
    // Go can print for a long stretch without yielding to the event loop,
    // where the timer could not fire, so flush by elapsed time as well.
    if (performance.now() - lastFlush > 50) flush();
    else timer ??= setTimeout(flush, 50);
  };

  let code: number;
  try {
    code = await runBinary(binary, { argv, dir, files, onOutput });
  } catch (err) {
    onOutput(2, new TextEncoder().encode(`\n${err}\n`));
    code = 2;
  }
  flush();
  self.postMessage({ type: "exit", code });
};
