// Stand-in for workers/stt/worker.py with the SAME stdin/stdout protocol, steered by FAKE_MODE. No GPU, no model, no audio kept.
// modes: ok | no_ready | load_error | crash_on_decode | hang_on_decode | bad_json_noise
const mode = process.env.FAKE_MODE ?? "ok";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (mode === "load_error") {
  send({ event: "error", error: "load_failed" });
  process.exit(2);
}
if (mode !== "no_ready") send({ event: "ready", protocol: 1, pid: process.pid, loadSeconds: 0.01, warmupSeconds: 0.01, device: "fake", computeType: "fake" });
process.stdin.on("close", () => process.exit(0));

let buf = Buffer.alloc(0);
let want = null; // bytes of PCM we are waiting for
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (want === null) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const msg = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      buf = buf.subarray(nl + 1);
      if (msg.op === "shutdown") {
        send({ ok: true, op: "shutdown" });
        process.exit(0);
      }
      if (msg.op === "ping") {
        send({ ok: true, op: "ping" });
        continue;
      }
      if (msg.op === "transcribe") want = msg.bytes;
    }
    if (want !== null) {
      if (buf.length < want) return;
      const pcm = buf.subarray(0, want);
      buf = buf.subarray(want);
      want = null;
      if (mode === "crash_on_decode") process.exit(1);
      if (mode === "hang_on_decode") return; // never answers
      if (mode === "bad_json_noise") process.stdout.write("this is not json\n");
      if (pcm.length < 3200) send({ ok: false, op: "transcribe", error: "too_short" });
      else send({ ok: true, op: "transcribe", text: process.env.FAKE_TEXT ?? "the employee stopped checking emails", audioSeconds: pcm.length / 32000, decodeSeconds: 0.01 });
    }
  }
});
