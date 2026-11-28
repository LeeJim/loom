import { consoleServer } from "./http.js";

consoleServer().listen(Number(process.env.LOOM_CONSOLE_PORT || "8790"), "127.0.0.1");
