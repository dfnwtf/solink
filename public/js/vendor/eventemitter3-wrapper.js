import EventEmitter from 'https://cdn.jsdelivr.net/npm/eventemitter3@4.0.7/+esm';

const emitter = EventEmitter;
emitter.EventEmitter = EventEmitter;
emitter.default = EventEmitter;

export default emitter;
export { EventEmitter };

