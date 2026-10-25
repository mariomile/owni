// The server inside the desktop app (docs/desktop.md, «Owni sul Mac»). The app holds this
// process's stdin open: when the app goes away, even by a crash, the server stops cleanly
// instead of keeping the data folder locked.
process.stdin.on("end", () => process.kill(process.pid, "SIGTERM"));
process.stdin.resume();
await import("./dist/main/owni.js");
