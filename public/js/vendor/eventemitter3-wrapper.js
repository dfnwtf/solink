import _EventEmitter from 'https://cdn.jsdelivr.net/npm/eventemitter3@4.0.7/+esm';

const emitter = _EventEmitter;
emitter.EventEmitter = emitter;
emitter.default = emitter;

console.info('[SOLINK] EventEmitter3 shim loaded:', import.meta.url);

export default emitter;
export { emitter as EventEmitter };

