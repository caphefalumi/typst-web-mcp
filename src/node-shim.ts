// Node 22+ installs a localStorage getter that warns on access; lib0 probes it at load time.
if (Object.getOwnPropertyDescriptor(globalThis, "localStorage")) {
  Reflect.deleteProperty(globalThis, "localStorage");
}
