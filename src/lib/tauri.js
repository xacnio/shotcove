// withGlobalTauri:true injects the bridge into the window; using the global
// API guarantees compatibility with the running Tauri version.
const tauri = window.__TAURI__ ?? {};

export const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
export const listen = (event, handler) => tauri.event.listen(event, handler);
export const emit = (event, payload) => tauri.event.emit(event, payload);
export const convertFileSrc = (path) => tauri.core.convertFileSrc(path);
