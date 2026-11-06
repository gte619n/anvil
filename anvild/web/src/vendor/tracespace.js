var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// ../../../../Development/anvil/anvild/node_modules/xtend/immutable.js
var require_immutable = __commonJS((exports, module) => {
  module.exports = extend;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  function extend() {
    var target = {};
    for (var i = 0;i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  }
});

// ../../../../Development/anvil/anvild/node_modules/queue-microtask/index.js
var require_queue_microtask = __commonJS((exports, module) => {
  /*! queue-microtask. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  var promise;
  module.exports = typeof queueMicrotask === "function" ? queueMicrotask.bind(typeof window !== "undefined" ? window : global) : (cb) => (promise || (promise = Promise.resolve())).then(cb).catch((err) => setTimeout(() => {
    throw err;
  }, 0));
});

// ../../../../Development/anvil/anvild/node_modules/run-parallel/index.js
var require_run_parallel = __commonJS((exports, module) => {
  /*! run-parallel. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  module.exports = runParallel;
  var queueMicrotask2 = require_queue_microtask();
  function runParallel(tasks, cb) {
    let results, pending, keys;
    let isSync = true;
    if (Array.isArray(tasks)) {
      results = [];
      pending = tasks.length;
    } else {
      keys = Object.keys(tasks);
      results = {};
      pending = keys.length;
    }
    function done(err) {
      function end() {
        if (cb)
          cb(err, results);
        cb = null;
      }
      if (isSync)
        queueMicrotask2(end);
      else
        end();
    }
    function each(i, err, result) {
      results[i] = result;
      if (--pending === 0 || err) {
        done(err);
      }
    }
    if (!pending) {
      done(null);
    } else if (keys) {
      keys.forEach(function(key) {
        tasks[key](function(err, result) {
          each(key, err, result);
        });
      });
    } else {
      tasks.forEach(function(task, i) {
        task(function(err, result) {
          each(i, err, result);
        });
      });
    }
    isSync = false;
  }
});

// ../../../../Development/anvil/anvild/node_modules/run-waterfall/index.js
var require_run_waterfall = __commonJS((exports, module) => {
  /*! run-waterfall. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  module.exports = runWaterfall;
  function runWaterfall(tasks, cb) {
    var current = 0;
    var isSync = true;
    function done(err, args) {
      function end() {
        args = args ? [].concat(err, args) : [err];
        if (cb)
          cb.apply(undefined, args);
      }
      if (isSync)
        process.nextTick(end);
      else
        end();
    }
    function each(err) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (++current >= tasks.length || err) {
        done(err, args);
      } else {
        tasks[current].apply(undefined, [].concat(args, each));
      }
    }
    if (tasks.length) {
      tasks[0](each);
    } else {
      done(null);
    }
    isSync = false;
  }
});

// ../../../../Development/anvil/anvild/node_modules/@tracespace/xml-id/index.js
var require_xml_id = __commonJS((exports, module) => {
  var START_CHAR = "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  var CHAR = "-0123456789" + START_CHAR;
  var REPLACE_RE = new RegExp("^[^" + START_CHAR + "]|[^\\" + CHAR + "]", "g");
  var DEFAULT_RANDOM_LENGTH = 12;
  module.exports = {
    random,
    sanitize,
    ensure
  };
  function random(length) {
    length = length || DEFAULT_RANDOM_LENGTH;
    return _getRandomString(1, START_CHAR) + _getRandomString(length - 1, CHAR);
  }
  function sanitize(source) {
    return source.replace(REPLACE_RE, "_");
  }
  function ensure(maybeId, length) {
    return typeof maybeId === "string" ? sanitize(maybeId) : random(length);
  }
  function _getRandomString(length, alphabet) {
    var abLength = alphabet.length;
    var result = "";
    while (length > 0) {
      length--;
      result += alphabet[Math.floor(Math.random() * abLength)];
    }
    return result;
  }
});

// ../../../../Development/anvil/anvild/node_modules/lodash.isfinite/index.js
var require_lodash = __commonJS((exports, module) => {
  var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
  var freeSelf = typeof self == "object" && self && self.Object === Object && self;
  var root = freeGlobal || freeSelf || Function("return this")();
  var nativeIsFinite = root.isFinite;
  function isFinite2(value) {
    return typeof value == "number" && nativeIsFinite(value);
  }
  module.exports = isFinite2;
});

// node:buffer
var exports_buffer = {};
__export(exports_buffer, {
  transcode: () => transcode,
  resolveObjectURL: () => resolveObjectURL,
  kStringMaxLength: () => kStringMaxLength,
  kMaxLength: () => kMaxLength,
  isUtf8: () => isUtf8,
  isAscii: () => isAscii,
  default: () => buffer_default,
  constants: () => constants,
  btoa: () => btoa,
  atob: () => atob,
  INSPECT_MAX_BYTES: () => INSPECT_MAX_BYTES,
  File: () => File,
  Buffer: () => Buffer2,
  Blob: () => Blob
});
function getLens(b64) {
  var len2 = b64.length;
  if (len2 % 4 > 0)
    throw Error("Invalid string. Length must be a multiple of 4");
  var validLen = b64.indexOf("=");
  if (validLen === -1)
    validLen = len2;
  var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
}
function _byteLength(validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}
function toByteArray(b64) {
  var tmp, lens = getLens(b64), validLen = lens[0], placeHoldersLen = lens[1], arr = new Uint8Array(_byteLength(validLen, placeHoldersLen)), curByte = 0, len2 = placeHoldersLen > 0 ? validLen - 4 : validLen, i2;
  for (i2 = 0;i2 < len2; i2 += 4)
    tmp = revLookup[b64.charCodeAt(i2)] << 18 | revLookup[b64.charCodeAt(i2 + 1)] << 12 | revLookup[b64.charCodeAt(i2 + 2)] << 6 | revLookup[b64.charCodeAt(i2 + 3)], arr[curByte++] = tmp >> 16 & 255, arr[curByte++] = tmp >> 8 & 255, arr[curByte++] = tmp & 255;
  if (placeHoldersLen === 2)
    tmp = revLookup[b64.charCodeAt(i2)] << 2 | revLookup[b64.charCodeAt(i2 + 1)] >> 4, arr[curByte++] = tmp & 255;
  if (placeHoldersLen === 1)
    tmp = revLookup[b64.charCodeAt(i2)] << 10 | revLookup[b64.charCodeAt(i2 + 1)] << 4 | revLookup[b64.charCodeAt(i2 + 2)] >> 2, arr[curByte++] = tmp >> 8 & 255, arr[curByte++] = tmp & 255;
  return arr;
}
function tripletToBase64(num) {
  return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
}
function encodeChunk(uint8, start, end) {
  var tmp, output = [];
  for (var i2 = start;i2 < end; i2 += 3)
    tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255), output.push(tripletToBase64(tmp));
  return output.join("");
}
function fromByteArray(uint8) {
  var tmp, len2 = uint8.length, extraBytes = len2 % 3, parts = [], maxChunkLength = 16383;
  for (var i2 = 0, len22 = len2 - extraBytes;i2 < len22; i2 += maxChunkLength)
    parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
  if (extraBytes === 1)
    tmp = uint8[len2 - 1], parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
  else if (extraBytes === 2)
    tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1], parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
  return parts.join("");
}
function read(buffer, offset, isLE, mLen, nBytes) {
  var e, m, eLen = nBytes * 8 - mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1, nBits = -7, i2 = isLE ? nBytes - 1 : 0, d = isLE ? -1 : 1, s = buffer[offset + i2];
  i2 += d, e = s & (1 << -nBits) - 1, s >>= -nBits, nBits += eLen;
  for (;nBits > 0; e = e * 256 + buffer[offset + i2], i2 += d, nBits -= 8)
    ;
  m = e & (1 << -nBits) - 1, e >>= -nBits, nBits += mLen;
  for (;nBits > 0; m = m * 256 + buffer[offset + i2], i2 += d, nBits -= 8)
    ;
  if (e === 0)
    e = 1 - eBias;
  else if (e === eMax)
    return m ? NaN : (s ? -1 : 1) * (1 / 0);
  else
    m = m + Math.pow(2, mLen), e = e - eBias;
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
}
function write(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c, eLen = nBytes * 8 - mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1, rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0, i2 = isLE ? 0 : nBytes - 1, d = isLE ? 1 : -1, s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
  if (value = Math.abs(value), isNaN(value) || value === 1 / 0)
    m = isNaN(value) ? 1 : 0, e = eMax;
  else {
    if (e = Math.floor(Math.log(value) / Math.LN2), value * (c = Math.pow(2, -e)) < 1)
      e--, c *= 2;
    if (e + eBias >= 1)
      value += rt / c;
    else
      value += rt * Math.pow(2, 1 - eBias);
    if (value * c >= 2)
      e++, c /= 2;
    if (e + eBias >= eMax)
      m = 0, e = eMax;
    else if (e + eBias >= 1)
      m = (value * c - 1) * Math.pow(2, mLen), e = e + eBias;
    else
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen), e = 0;
  }
  for (;mLen >= 8; buffer[offset + i2] = m & 255, i2 += d, m /= 256, mLen -= 8)
    ;
  e = e << mLen | m, eLen += mLen;
  for (;eLen > 0; buffer[offset + i2] = e & 255, i2 += d, e /= 256, eLen -= 8)
    ;
  buffer[offset + i2 - d] |= s * 128;
}
function createBuffer(length) {
  if (length > kMaxLength)
    throw RangeError('The value "' + length + '" is invalid for option "size"');
  let buf = new Uint8Array(length);
  return Object.setPrototypeOf(buf, Buffer2.prototype), buf;
}
function E(sym, getMessage, Base) {
  return class extends Base {
    constructor() {
      super();
      Object.defineProperty(this, "message", { value: getMessage.apply(this, arguments), writable: true, configurable: true }), this.name = `${this.name} [${sym}]`, this.stack, delete this.name;
    }
    get code() {
      return sym;
    }
    set code(value) {
      Object.defineProperty(this, "code", { configurable: true, enumerable: true, value, writable: true });
    }
    toString() {
      return `${this.name} [${sym}]: ${this.message}`;
    }
  };
}
function Buffer2(arg, encodingOrOffset, length) {
  if (typeof arg === "number") {
    if (typeof encodingOrOffset === "string")
      throw TypeError('The "string" argument must be of type string. Received type number');
    return allocUnsafe(arg);
  }
  return from(arg, encodingOrOffset, length);
}
function from(value, encodingOrOffset, length) {
  if (typeof value === "string")
    return fromString(value, encodingOrOffset);
  if (ArrayBuffer.isView(value))
    return fromArrayView(value);
  if (value == null)
    throw TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
  if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer))
    return fromArrayBuffer(value, encodingOrOffset, length);
  if (typeof SharedArrayBuffer < "u" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer)))
    return fromArrayBuffer(value, encodingOrOffset, length);
  if (typeof value === "number")
    throw TypeError('The "value" argument must not be of type number. Received type number');
  let valueOf = value.valueOf && value.valueOf();
  if (valueOf != null && valueOf !== value)
    return Buffer2.from(valueOf, encodingOrOffset, length);
  let b = fromObject(value);
  if (b)
    return b;
  if (typeof Symbol < "u" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function")
    return Buffer2.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
  throw TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
}
function assertSize(size) {
  if (typeof size !== "number")
    throw TypeError('"size" argument must be of type number');
  else if (size < 0)
    throw RangeError('The value "' + size + '" is invalid for option "size"');
}
function alloc(size, fill, encoding) {
  if (assertSize(size), size <= 0)
    return createBuffer(size);
  if (fill !== undefined)
    return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
  return createBuffer(size);
}
function allocUnsafe(size) {
  return assertSize(size), createBuffer(size < 0 ? 0 : checked(size) | 0);
}
function fromString(string, encoding) {
  if (typeof encoding !== "string" || encoding === "")
    encoding = "utf8";
  if (!Buffer2.isEncoding(encoding))
    throw TypeError("Unknown encoding: " + encoding);
  let length = byteLength(string, encoding) | 0, buf = createBuffer(length), actual = buf.write(string, encoding);
  if (actual !== length)
    buf = buf.slice(0, actual);
  return buf;
}
function fromArrayLike(array) {
  let length = array.length < 0 ? 0 : checked(array.length) | 0, buf = createBuffer(length);
  for (let i2 = 0;i2 < length; i2 += 1)
    buf[i2] = array[i2] & 255;
  return buf;
}
function fromArrayView(arrayView) {
  if (isInstance(arrayView, Uint8Array)) {
    let copy = new Uint8Array(arrayView);
    return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
  }
  return fromArrayLike(arrayView);
}
function fromArrayBuffer(array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset)
    throw RangeError('"offset" is outside of buffer bounds');
  if (array.byteLength < byteOffset + (length || 0))
    throw RangeError('"length" is outside of buffer bounds');
  let buf;
  if (byteOffset === undefined && length === undefined)
    buf = new Uint8Array(array);
  else if (length === undefined)
    buf = new Uint8Array(array, byteOffset);
  else
    buf = new Uint8Array(array, byteOffset, length);
  return Object.setPrototypeOf(buf, Buffer2.prototype), buf;
}
function fromObject(obj) {
  if (Buffer2.isBuffer(obj)) {
    let len2 = checked(obj.length) | 0, buf = createBuffer(len2);
    if (buf.length === 0)
      return buf;
    return obj.copy(buf, 0, 0, len2), buf;
  }
  if (obj.length !== undefined) {
    if (typeof obj.length !== "number" || Number.isNaN(obj.length))
      return createBuffer(0);
    return fromArrayLike(obj);
  }
  if (obj.type === "Buffer" && Array.isArray(obj.data))
    return fromArrayLike(obj.data);
}
function checked(length) {
  if (length >= kMaxLength)
    throw RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + kMaxLength.toString(16) + " bytes");
  return length | 0;
}
function byteLength(string, encoding) {
  if (Buffer2.isBuffer(string))
    return string.length;
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer))
    return string.byteLength;
  if (typeof string !== "string")
    throw TypeError('The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string);
  let len2 = string.length, mustMatch = arguments.length > 2 && arguments[2] === true;
  if (!mustMatch && len2 === 0)
    return 0;
  let loweredCase = false;
  for (;; )
    switch (encoding) {
      case "ascii":
      case "latin1":
      case "binary":
        return len2;
      case "utf8":
      case "utf-8":
        return utf8ToBytes(string).length;
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return len2 * 2;
      case "hex":
        return len2 >>> 1;
      case "base64":
        return base64ToBytes(string).length;
      default:
        if (loweredCase)
          return mustMatch ? -1 : utf8ToBytes(string).length;
        encoding = ("" + encoding).toLowerCase(), loweredCase = true;
    }
}
function slowToString(encoding, start, end) {
  let loweredCase = false;
  if (start === undefined || start < 0)
    start = 0;
  if (start > this.length)
    return "";
  if (end === undefined || end > this.length)
    end = this.length;
  if (end <= 0)
    return "";
  if (end >>>= 0, start >>>= 0, end <= start)
    return "";
  if (!encoding)
    encoding = "utf8";
  while (true)
    switch (encoding) {
      case "hex":
        return hexSlice(this, start, end);
      case "utf8":
      case "utf-8":
        return utf8Slice(this, start, end);
      case "ascii":
        return asciiSlice(this, start, end);
      case "latin1":
      case "binary":
        return latin1Slice(this, start, end);
      case "base64":
        return base64Slice(this, start, end);
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return utf16leSlice(this, start, end);
      default:
        if (loweredCase)
          throw TypeError("Unknown encoding: " + encoding);
        encoding = (encoding + "").toLowerCase(), loweredCase = true;
    }
}
function swap(b, n, m) {
  let i2 = b[n];
  b[n] = b[m], b[m] = i2;
}
function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  if (buffer.length === 0)
    return -1;
  if (typeof byteOffset === "string")
    encoding = byteOffset, byteOffset = 0;
  else if (byteOffset > 2147483647)
    byteOffset = 2147483647;
  else if (byteOffset < -2147483648)
    byteOffset = -2147483648;
  if (byteOffset = +byteOffset, Number.isNaN(byteOffset))
    byteOffset = dir ? 0 : buffer.length - 1;
  if (byteOffset < 0)
    byteOffset = buffer.length + byteOffset;
  if (byteOffset >= buffer.length)
    if (dir)
      return -1;
    else
      byteOffset = buffer.length - 1;
  else if (byteOffset < 0)
    if (dir)
      byteOffset = 0;
    else
      return -1;
  if (typeof val === "string")
    val = Buffer2.from(val, encoding);
  if (Buffer2.isBuffer(val)) {
    if (val.length === 0)
      return -1;
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
  } else if (typeof val === "number") {
    if (val = val & 255, typeof Uint8Array.prototype.indexOf === "function")
      if (dir)
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
      else
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
    return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
  }
  throw TypeError("val must be string, number or Buffer");
}
function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
  let indexSize = 1, arrLength = arr.length, valLength = val.length;
  if (encoding !== undefined) {
    if (encoding = String(encoding).toLowerCase(), encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
      if (arr.length < 2 || val.length < 2)
        return -1;
      indexSize = 2, arrLength /= 2, valLength /= 2, byteOffset /= 2;
    }
  }
  function read2(buf, i3) {
    if (indexSize === 1)
      return buf[i3];
    else
      return buf.readUInt16BE(i3 * indexSize);
  }
  let i2;
  if (dir) {
    let foundIndex = -1;
    for (i2 = byteOffset;i2 < arrLength; i2++)
      if (read2(arr, i2) === read2(val, foundIndex === -1 ? 0 : i2 - foundIndex)) {
        if (foundIndex === -1)
          foundIndex = i2;
        if (i2 - foundIndex + 1 === valLength)
          return foundIndex * indexSize;
      } else {
        if (foundIndex !== -1)
          i2 -= i2 - foundIndex;
        foundIndex = -1;
      }
  } else {
    if (byteOffset + valLength > arrLength)
      byteOffset = arrLength - valLength;
    for (i2 = byteOffset;i2 >= 0; i2--) {
      let found = true;
      for (let j = 0;j < valLength; j++)
        if (read2(arr, i2 + j) !== read2(val, j)) {
          found = false;
          break;
        }
      if (found)
        return i2;
    }
  }
  return -1;
}
function hexWrite(buf, string, offset, length) {
  offset = Number(offset) || 0;
  let remaining = buf.length - offset;
  if (!length)
    length = remaining;
  else if (length = Number(length), length > remaining)
    length = remaining;
  let strLen = string.length;
  if (length > strLen / 2)
    length = strLen / 2;
  let i2;
  for (i2 = 0;i2 < length; ++i2) {
    let parsed = parseInt(string.substr(i2 * 2, 2), 16);
    if (Number.isNaN(parsed))
      return i2;
    buf[offset + i2] = parsed;
  }
  return i2;
}
function utf8Write(buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
}
function asciiWrite(buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length);
}
function base64Write(buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length);
}
function ucs2Write(buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
}
function base64Slice(buf, start, end) {
  if (start === 0 && end === buf.length)
    return fromByteArray(buf);
  else
    return fromByteArray(buf.slice(start, end));
}
function utf8Slice(buf, start, end) {
  end = Math.min(buf.length, end);
  let res = [], i2 = start;
  while (i2 < end) {
    let firstByte = buf[i2], codePoint = null, bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
    if (i2 + bytesPerSequence <= end) {
      let secondByte, thirdByte, fourthByte, tempCodePoint;
      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 128)
            codePoint = firstByte;
          break;
        case 2:
          if (secondByte = buf[i2 + 1], (secondByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 31) << 6 | secondByte & 63, tempCodePoint > 127)
              codePoint = tempCodePoint;
          }
          break;
        case 3:
          if (secondByte = buf[i2 + 1], thirdByte = buf[i2 + 2], (secondByte & 192) === 128 && (thirdByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63, tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343))
              codePoint = tempCodePoint;
          }
          break;
        case 4:
          if (secondByte = buf[i2 + 1], thirdByte = buf[i2 + 2], fourthByte = buf[i2 + 3], (secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63, tempCodePoint > 65535 && tempCodePoint < 1114112)
              codePoint = tempCodePoint;
          }
      }
    }
    if (codePoint === null)
      codePoint = 65533, bytesPerSequence = 1;
    else if (codePoint > 65535)
      codePoint -= 65536, res.push(codePoint >>> 10 & 1023 | 55296), codePoint = 56320 | codePoint & 1023;
    res.push(codePoint), i2 += bytesPerSequence;
  }
  return decodeCodePointsArray(res);
}
function decodeCodePointsArray(codePoints) {
  let len2 = codePoints.length;
  if (len2 <= MAX_ARGUMENTS_LENGTH)
    return String.fromCharCode.apply(String, codePoints);
  let res = "", i2 = 0;
  while (i2 < len2)
    res += String.fromCharCode.apply(String, codePoints.slice(i2, i2 += MAX_ARGUMENTS_LENGTH));
  return res;
}
function asciiSlice(buf, start, end) {
  let ret = "";
  end = Math.min(buf.length, end);
  for (let i2 = start;i2 < end; ++i2)
    ret += String.fromCharCode(buf[i2] & 127);
  return ret;
}
function latin1Slice(buf, start, end) {
  let ret = "";
  end = Math.min(buf.length, end);
  for (let i2 = start;i2 < end; ++i2)
    ret += String.fromCharCode(buf[i2]);
  return ret;
}
function hexSlice(buf, start, end) {
  let len2 = buf.length;
  if (!start || start < 0)
    start = 0;
  if (!end || end < 0 || end > len2)
    end = len2;
  let out = "";
  for (let i2 = start;i2 < end; ++i2)
    out += hexSliceLookupTable[buf[i2]];
  return out;
}
function utf16leSlice(buf, start, end) {
  let bytes = buf.slice(start, end), res = "";
  for (let i2 = 0;i2 < bytes.length - 1; i2 += 2)
    res += String.fromCharCode(bytes[i2] + bytes[i2 + 1] * 256);
  return res;
}
function checkOffset(offset, ext, length) {
  if (offset % 1 !== 0 || offset < 0)
    throw RangeError("offset is not uint");
  if (offset + ext > length)
    throw RangeError("Trying to access beyond buffer length");
}
function checkInt(buf, value, offset, ext, max, min) {
  if (!Buffer2.isBuffer(buf))
    throw TypeError('"buffer" argument must be a Buffer instance');
  if (value > max || value < min)
    throw RangeError('"value" argument is out of bounds');
  if (offset + ext > buf.length)
    throw RangeError("Index out of range");
}
function wrtBigUInt64LE(buf, value, offset, min, max) {
  checkIntBI(value, min, max, buf, offset, 7);
  let lo = Number(value & BigInt(4294967295));
  buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo;
  let hi = Number(value >> BigInt(32) & BigInt(4294967295));
  return buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, offset;
}
function wrtBigUInt64BE(buf, value, offset, min, max) {
  checkIntBI(value, min, max, buf, offset, 7);
  let lo = Number(value & BigInt(4294967295));
  buf[offset + 7] = lo, lo = lo >> 8, buf[offset + 6] = lo, lo = lo >> 8, buf[offset + 5] = lo, lo = lo >> 8, buf[offset + 4] = lo;
  let hi = Number(value >> BigInt(32) & BigInt(4294967295));
  return buf[offset + 3] = hi, hi = hi >> 8, buf[offset + 2] = hi, hi = hi >> 8, buf[offset + 1] = hi, hi = hi >> 8, buf[offset] = hi, offset + 8;
}
function checkIEEE754(buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length)
    throw RangeError("Index out of range");
  if (offset < 0)
    throw RangeError("Index out of range");
}
function writeFloat(buf, value, offset, littleEndian, noAssert) {
  if (value = +value, offset = offset >>> 0, !noAssert)
    checkIEEE754(buf, value, offset, 4, 340282346638528860000000000000000000000, -340282346638528860000000000000000000000);
  return write(buf, value, offset, littleEndian, 23, 4), offset + 4;
}
function writeDouble(buf, value, offset, littleEndian, noAssert) {
  if (value = +value, offset = offset >>> 0, !noAssert)
    checkIEEE754(buf, value, offset, 8, 179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000, -179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000);
  return write(buf, value, offset, littleEndian, 52, 8), offset + 8;
}
function addNumericalSeparator(val) {
  let res = "", i2 = val.length, start = val[0] === "-" ? 1 : 0;
  for (;i2 >= start + 4; i2 -= 3)
    res = `_${val.slice(i2 - 3, i2)}${res}`;
  return `${val.slice(0, i2)}${res}`;
}
function checkBounds(buf, offset, byteLength2) {
  if (validateNumber(offset, "offset"), buf[offset] === undefined || buf[offset + byteLength2] === undefined)
    boundsError(offset, buf.length - (byteLength2 + 1));
}
function checkIntBI(value, min, max, buf, offset, byteLength2) {
  if (value > max || value < min) {
    let n = typeof min === "bigint" ? "n" : "", range;
    if (byteLength2 > 3)
      if (min === 0 || min === BigInt(0))
        range = `>= 0${n} and < 2${n} ** ${(byteLength2 + 1) * 8}${n}`;
      else
        range = `>= -(2${n} ** ${(byteLength2 + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength2 + 1) * 8 - 1}${n}`;
    else
      range = `>= ${min}${n} and <= ${max}${n}`;
    throw new ERR_OUT_OF_RANGE("value", range, value);
  }
  checkBounds(buf, offset, byteLength2);
}
function validateNumber(value, name) {
  if (typeof value !== "number")
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}
function boundsError(value, length, type) {
  if (Math.floor(value) !== value)
    throw validateNumber(value, type), new ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
  if (length < 0)
    throw new ERR_BUFFER_OUT_OF_BOUNDS;
  throw new ERR_OUT_OF_RANGE(type || "offset", `>= ${type ? 1 : 0} and <= ${length}`, value);
}
function base64clean(str) {
  if (str = str.split("=")[0], str = str.trim().replace(INVALID_BASE64_RE, ""), str.length < 2)
    return "";
  while (str.length % 4 !== 0)
    str = str + "=";
  return str;
}
function utf8ToBytes(string, units) {
  units = units || 1 / 0;
  let codePoint, length = string.length, leadSurrogate = null, bytes = [];
  for (let i2 = 0;i2 < length; ++i2) {
    if (codePoint = string.charCodeAt(i2), codePoint > 55295 && codePoint < 57344) {
      if (!leadSurrogate) {
        if (codePoint > 56319) {
          if ((units -= 3) > -1)
            bytes.push(239, 191, 189);
          continue;
        } else if (i2 + 1 === length) {
          if ((units -= 3) > -1)
            bytes.push(239, 191, 189);
          continue;
        }
        leadSurrogate = codePoint;
        continue;
      }
      if (codePoint < 56320) {
        if ((units -= 3) > -1)
          bytes.push(239, 191, 189);
        leadSurrogate = codePoint;
        continue;
      }
      codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
    } else if (leadSurrogate) {
      if ((units -= 3) > -1)
        bytes.push(239, 191, 189);
    }
    if (leadSurrogate = null, codePoint < 128) {
      if ((units -= 1) < 0)
        break;
      bytes.push(codePoint);
    } else if (codePoint < 2048) {
      if ((units -= 2) < 0)
        break;
      bytes.push(codePoint >> 6 | 192, codePoint & 63 | 128);
    } else if (codePoint < 65536) {
      if ((units -= 3) < 0)
        break;
      bytes.push(codePoint >> 12 | 224, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
    } else if (codePoint < 1114112) {
      if ((units -= 4) < 0)
        break;
      bytes.push(codePoint >> 18 | 240, codePoint >> 12 & 63 | 128, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
    } else
      throw Error("Invalid code point");
  }
  return bytes;
}
function asciiToBytes(str) {
  let byteArray = [];
  for (let i2 = 0;i2 < str.length; ++i2)
    byteArray.push(str.charCodeAt(i2) & 255);
  return byteArray;
}
function utf16leToBytes(str, units) {
  let c, hi, lo, byteArray = [];
  for (let i2 = 0;i2 < str.length; ++i2) {
    if ((units -= 2) < 0)
      break;
    c = str.charCodeAt(i2), hi = c >> 8, lo = c % 256, byteArray.push(lo), byteArray.push(hi);
  }
  return byteArray;
}
function base64ToBytes(str) {
  return toByteArray(base64clean(str));
}
function blitBuffer(src, dst, offset, length) {
  let i2;
  for (i2 = 0;i2 < length; ++i2) {
    if (i2 + offset >= dst.length || i2 >= src.length)
      break;
    dst[i2 + offset] = src[i2];
  }
  return i2;
}
function isInstance(obj, type) {
  return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
}
function defineBigIntMethod(fn) {
  return typeof BigInt > "u" ? BufferBigIntNotDefined : fn;
}
function BufferBigIntNotDefined() {
  throw Error("BigInt not supported");
}
function notimpl(name) {
  return () => {
    throw Error(name + " is not implemented for node:buffer browser polyfill");
  };
}
var lookup, revLookup, code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", i, len, customInspectSymbol, INSPECT_MAX_BYTES = 50, kMaxLength = 2147483647, kStringMaxLength = 536870888, btoa, atob, File, Blob, constants, ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, MAX_ARGUMENTS_LENGTH = 4096, INVALID_BASE64_RE, hexSliceLookupTable, resolveObjectURL, isUtf8, isAscii = (str) => {
  for (let char of str)
    if (char.charCodeAt(0) > 127)
      return false;
  return true;
}, transcode, buffer_default;
var init_buffer = __esm(() => {
  lookup = [];
  revLookup = [];
  for (i = 0, len = code.length;i < len; ++i)
    lookup[i] = code[i], revLookup[code.charCodeAt(i)] = i;
  revLookup[45] = 62;
  revLookup[95] = 63;
  customInspectSymbol = typeof Symbol === "function" && typeof Symbol.for === "function" ? Symbol.for("nodejs.util.inspect.custom") : null;
  btoa = globalThis.btoa;
  atob = globalThis.atob;
  File = globalThis.File;
  Blob = globalThis.Blob;
  constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
  ERR_BUFFER_OUT_OF_BOUNDS = E("ERR_BUFFER_OUT_OF_BOUNDS", function(name) {
    if (name)
      return `${name} is outside of buffer bounds`;
    return "Attempt to access memory outside buffer bounds";
  }, RangeError);
  ERR_INVALID_ARG_TYPE = E("ERR_INVALID_ARG_TYPE", function(name, actual) {
    return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
  }, TypeError);
  ERR_OUT_OF_RANGE = E("ERR_OUT_OF_RANGE", function(str, range, input) {
    let msg = `The value of "${str}" is out of range.`, received = input;
    if (Number.isInteger(input) && Math.abs(input) > 4294967296)
      received = addNumericalSeparator(String(input));
    else if (typeof input === "bigint") {
      if (received = String(input), input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32)))
        received = addNumericalSeparator(received);
      received += "n";
    }
    return msg += ` It must be ${range}. Received ${received}`, msg;
  }, RangeError);
  Object.defineProperty(Buffer2.prototype, "parent", { enumerable: true, get: function() {
    if (!Buffer2.isBuffer(this))
      return;
    return this.buffer;
  } });
  Object.defineProperty(Buffer2.prototype, "offset", { enumerable: true, get: function() {
    if (!Buffer2.isBuffer(this))
      return;
    return this.byteOffset;
  } });
  Buffer2.poolSize = 8192;
  Buffer2.from = function(value, encodingOrOffset, length) {
    return from(value, encodingOrOffset, length);
  };
  Object.setPrototypeOf(Buffer2.prototype, Uint8Array.prototype);
  Object.setPrototypeOf(Buffer2, Uint8Array);
  Buffer2.alloc = function(size, fill, encoding) {
    return alloc(size, fill, encoding);
  };
  Buffer2.allocUnsafe = function(size) {
    return allocUnsafe(size);
  };
  Buffer2.allocUnsafeSlow = function(size) {
    return allocUnsafe(size);
  };
  Buffer2.isBuffer = function(b) {
    return b != null && b._isBuffer === true && b !== Buffer2.prototype;
  };
  Buffer2.compare = function(a, b) {
    if (isInstance(a, Uint8Array))
      a = Buffer2.from(a, a.offset, a.byteLength);
    if (isInstance(b, Uint8Array))
      b = Buffer2.from(b, b.offset, b.byteLength);
    if (!Buffer2.isBuffer(a) || !Buffer2.isBuffer(b))
      throw TypeError('The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array');
    if (a === b)
      return 0;
    let x = a.length, y = b.length;
    for (let i2 = 0, len2 = Math.min(x, y);i2 < len2; ++i2)
      if (a[i2] !== b[i2]) {
        x = a[i2], y = b[i2];
        break;
      }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer2.isEncoding = function(encoding) {
    switch (String(encoding).toLowerCase()) {
      case "hex":
      case "utf8":
      case "utf-8":
      case "ascii":
      case "latin1":
      case "binary":
      case "base64":
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return true;
      default:
        return false;
    }
  };
  Buffer2.concat = function(list, length) {
    if (!Array.isArray(list))
      throw TypeError('"list" argument must be an Array of Buffers');
    if (list.length === 0)
      return Buffer2.alloc(0);
    let i2;
    if (length === undefined) {
      length = 0;
      for (i2 = 0;i2 < list.length; ++i2)
        length += list[i2].length;
    }
    let buffer = Buffer2.allocUnsafe(length), pos = 0;
    for (i2 = 0;i2 < list.length; ++i2) {
      let buf = list[i2];
      if (isInstance(buf, Uint8Array))
        if (pos + buf.length > buffer.length) {
          if (!Buffer2.isBuffer(buf))
            buf = Buffer2.from(buf);
          buf.copy(buffer, pos);
        } else
          Uint8Array.prototype.set.call(buffer, buf, pos);
      else if (!Buffer2.isBuffer(buf))
        throw TypeError('"list" argument must be an Array of Buffers');
      else
        buf.copy(buffer, pos);
      pos += buf.length;
    }
    return buffer;
  };
  Buffer2.byteLength = byteLength;
  Buffer2.prototype._isBuffer = true;
  Buffer2.prototype.swap16 = function() {
    let len2 = this.length;
    if (len2 % 2 !== 0)
      throw RangeError("Buffer size must be a multiple of 16-bits");
    for (let i2 = 0;i2 < len2; i2 += 2)
      swap(this, i2, i2 + 1);
    return this;
  };
  Buffer2.prototype.swap32 = function() {
    let len2 = this.length;
    if (len2 % 4 !== 0)
      throw RangeError("Buffer size must be a multiple of 32-bits");
    for (let i2 = 0;i2 < len2; i2 += 4)
      swap(this, i2, i2 + 3), swap(this, i2 + 1, i2 + 2);
    return this;
  };
  Buffer2.prototype.swap64 = function() {
    let len2 = this.length;
    if (len2 % 8 !== 0)
      throw RangeError("Buffer size must be a multiple of 64-bits");
    for (let i2 = 0;i2 < len2; i2 += 8)
      swap(this, i2, i2 + 7), swap(this, i2 + 1, i2 + 6), swap(this, i2 + 2, i2 + 5), swap(this, i2 + 3, i2 + 4);
    return this;
  };
  Buffer2.prototype.toString = function() {
    let length = this.length;
    if (length === 0)
      return "";
    if (arguments.length === 0)
      return utf8Slice(this, 0, length);
    return slowToString.apply(this, arguments);
  };
  Buffer2.prototype.toLocaleString = Buffer2.prototype.toString;
  Buffer2.prototype.equals = function(b) {
    if (!Buffer2.isBuffer(b))
      throw TypeError("Argument must be a Buffer");
    if (this === b)
      return true;
    return Buffer2.compare(this, b) === 0;
  };
  Buffer2.prototype.inspect = function() {
    let str = "", max = INSPECT_MAX_BYTES;
    if (str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim(), this.length > max)
      str += " ... ";
    return "<Buffer " + str + ">";
  };
  if (customInspectSymbol)
    Buffer2.prototype[customInspectSymbol] = Buffer2.prototype.inspect;
  Buffer2.prototype.compare = function(target, start, end, thisStart, thisEnd) {
    if (isInstance(target, Uint8Array))
      target = Buffer2.from(target, target.offset, target.byteLength);
    if (!Buffer2.isBuffer(target))
      throw TypeError('The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target);
    if (start === undefined)
      start = 0;
    if (end === undefined)
      end = target ? target.length : 0;
    if (thisStart === undefined)
      thisStart = 0;
    if (thisEnd === undefined)
      thisEnd = this.length;
    if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length)
      throw RangeError("out of range index");
    if (thisStart >= thisEnd && start >= end)
      return 0;
    if (thisStart >= thisEnd)
      return -1;
    if (start >= end)
      return 1;
    if (start >>>= 0, end >>>= 0, thisStart >>>= 0, thisEnd >>>= 0, this === target)
      return 0;
    let x = thisEnd - thisStart, y = end - start, len2 = Math.min(x, y), thisCopy = this.slice(thisStart, thisEnd), targetCopy = target.slice(start, end);
    for (let i2 = 0;i2 < len2; ++i2)
      if (thisCopy[i2] !== targetCopy[i2]) {
        x = thisCopy[i2], y = targetCopy[i2];
        break;
      }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer2.prototype.includes = function(val, byteOffset, encoding) {
    return this.indexOf(val, byteOffset, encoding) !== -1;
  };
  Buffer2.prototype.indexOf = function(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
  };
  Buffer2.prototype.lastIndexOf = function(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
  };
  Buffer2.prototype.write = function(string, offset, length, encoding) {
    if (offset === undefined)
      encoding = "utf8", length = this.length, offset = 0;
    else if (length === undefined && typeof offset === "string")
      encoding = offset, length = this.length, offset = 0;
    else if (isFinite(offset))
      if (offset = offset >>> 0, isFinite(length)) {
        if (length = length >>> 0, encoding === undefined)
          encoding = "utf8";
      } else
        encoding = length, length = undefined;
    else
      throw Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");
    let remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length)
      throw RangeError("Attempt to write outside buffer bounds");
    if (!encoding)
      encoding = "utf8";
    let loweredCase = false;
    for (;; )
      switch (encoding) {
        case "hex":
          return hexWrite(this, string, offset, length);
        case "utf8":
        case "utf-8":
          return utf8Write(this, string, offset, length);
        case "ascii":
        case "latin1":
        case "binary":
          return asciiWrite(this, string, offset, length);
        case "base64":
          return base64Write(this, string, offset, length);
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw TypeError("Unknown encoding: " + encoding);
          encoding = ("" + encoding).toLowerCase(), loweredCase = true;
      }
  };
  Buffer2.prototype.toJSON = function() {
    return { type: "Buffer", data: Array.prototype.slice.call(this._arr || this, 0) };
  };
  Buffer2.prototype.slice = function(start, end) {
    let len2 = this.length;
    if (start = ~~start, end = end === undefined ? len2 : ~~end, start < 0) {
      if (start += len2, start < 0)
        start = 0;
    } else if (start > len2)
      start = len2;
    if (end < 0) {
      if (end += len2, end < 0)
        end = 0;
    } else if (end > len2)
      end = len2;
    if (end < start)
      end = start;
    let newBuf = this.subarray(start, end);
    return Object.setPrototypeOf(newBuf, Buffer2.prototype), newBuf;
  };
  Buffer2.prototype.readUintLE = Buffer2.prototype.readUIntLE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset], mul = 1, i2 = 0;
    while (++i2 < byteLength2 && (mul *= 256))
      val += this[offset + i2] * mul;
    return val;
  };
  Buffer2.prototype.readUintBE = Buffer2.prototype.readUIntBE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset + --byteLength2], mul = 1;
    while (byteLength2 > 0 && (mul *= 256))
      val += this[offset + --byteLength2] * mul;
    return val;
  };
  Buffer2.prototype.readUint8 = Buffer2.prototype.readUInt8 = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer2.prototype.readUint16LE = Buffer2.prototype.readUInt16LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | this[offset + 1] << 8;
  };
  Buffer2.prototype.readUint16BE = Buffer2.prototype.readUInt16BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] << 8 | this[offset + 1];
  };
  Buffer2.prototype.readUint32LE = Buffer2.prototype.readUInt32LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
  };
  Buffer2.prototype.readUint32BE = Buffer2.prototype.readUInt32BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
  };
  Buffer2.prototype.readBigUInt64LE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let lo = first + this[++offset] * 256 + this[++offset] * 65536 + this[++offset] * 16777216, hi = this[++offset] + this[++offset] * 256 + this[++offset] * 65536 + last * 16777216;
    return BigInt(lo) + (BigInt(hi) << BigInt(32));
  });
  Buffer2.prototype.readBigUInt64BE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let hi = first * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + this[++offset], lo = this[++offset] * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + last;
    return (BigInt(hi) << BigInt(32)) + BigInt(lo);
  });
  Buffer2.prototype.readIntLE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset], mul = 1, i2 = 0;
    while (++i2 < byteLength2 && (mul *= 256))
      val += this[offset + i2] * mul;
    if (mul *= 128, val >= mul)
      val -= Math.pow(2, 8 * byteLength2);
    return val;
  };
  Buffer2.prototype.readIntBE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let i2 = byteLength2, mul = 1, val = this[offset + --i2];
    while (i2 > 0 && (mul *= 256))
      val += this[offset + --i2] * mul;
    if (mul *= 128, val >= mul)
      val -= Math.pow(2, 8 * byteLength2);
    return val;
  };
  Buffer2.prototype.readInt8 = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 128))
      return this[offset];
    return (255 - this[offset] + 1) * -1;
  };
  Buffer2.prototype.readInt16LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    let val = this[offset] | this[offset + 1] << 8;
    return val & 32768 ? val | 4294901760 : val;
  };
  Buffer2.prototype.readInt16BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    let val = this[offset + 1] | this[offset] << 8;
    return val & 32768 ? val | 4294901760 : val;
  };
  Buffer2.prototype.readInt32LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
  };
  Buffer2.prototype.readInt32BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
  };
  Buffer2.prototype.readBigInt64LE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let val = this[offset + 4] + this[offset + 5] * 256 + this[offset + 6] * 65536 + (last << 24);
    return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 256 + this[++offset] * 65536 + this[++offset] * 16777216);
  });
  Buffer2.prototype.readBigInt64BE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let val = (first << 24) + this[++offset] * 65536 + this[++offset] * 256 + this[++offset];
    return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + last);
  });
  Buffer2.prototype.readFloatLE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return read(this, offset, true, 23, 4);
  };
  Buffer2.prototype.readFloatBE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return read(this, offset, false, 23, 4);
  };
  Buffer2.prototype.readDoubleLE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 8, this.length);
    return read(this, offset, true, 52, 8);
  };
  Buffer2.prototype.readDoubleBE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 8, this.length);
    return read(this, offset, false, 52, 8);
  };
  Buffer2.prototype.writeUintLE = Buffer2.prototype.writeUIntLE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert) {
      let maxBytes = Math.pow(2, 8 * byteLength2) - 1;
      checkInt(this, value, offset, byteLength2, maxBytes, 0);
    }
    let mul = 1, i2 = 0;
    this[offset] = value & 255;
    while (++i2 < byteLength2 && (mul *= 256))
      this[offset + i2] = value / mul & 255;
    return offset + byteLength2;
  };
  Buffer2.prototype.writeUintBE = Buffer2.prototype.writeUIntBE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert) {
      let maxBytes = Math.pow(2, 8 * byteLength2) - 1;
      checkInt(this, value, offset, byteLength2, maxBytes, 0);
    }
    let i2 = byteLength2 - 1, mul = 1;
    this[offset + i2] = value & 255;
    while (--i2 >= 0 && (mul *= 256))
      this[offset + i2] = value / mul & 255;
    return offset + byteLength2;
  };
  Buffer2.prototype.writeUint8 = Buffer2.prototype.writeUInt8 = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 1, 255, 0);
    return this[offset] = value & 255, offset + 1;
  };
  Buffer2.prototype.writeUint16LE = Buffer2.prototype.writeUInt16LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 65535, 0);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, offset + 2;
  };
  Buffer2.prototype.writeUint16BE = Buffer2.prototype.writeUInt16BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 65535, 0);
    return this[offset] = value >>> 8, this[offset + 1] = value & 255, offset + 2;
  };
  Buffer2.prototype.writeUint32LE = Buffer2.prototype.writeUInt32LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 4294967295, 0);
    return this[offset + 3] = value >>> 24, this[offset + 2] = value >>> 16, this[offset + 1] = value >>> 8, this[offset] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeUint32BE = Buffer2.prototype.writeUInt32BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 4294967295, 0);
    return this[offset] = value >>> 24, this[offset + 1] = value >>> 16, this[offset + 2] = value >>> 8, this[offset + 3] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeBigUInt64LE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
  });
  Buffer2.prototype.writeBigUInt64BE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
  });
  Buffer2.prototype.writeIntLE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert) {
      let limit = Math.pow(2, 8 * byteLength2 - 1);
      checkInt(this, value, offset, byteLength2, limit - 1, -limit);
    }
    let i2 = 0, mul = 1, sub = 0;
    this[offset] = value & 255;
    while (++i2 < byteLength2 && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i2 - 1] !== 0)
        sub = 1;
      this[offset + i2] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength2;
  };
  Buffer2.prototype.writeIntBE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert) {
      let limit = Math.pow(2, 8 * byteLength2 - 1);
      checkInt(this, value, offset, byteLength2, limit - 1, -limit);
    }
    let i2 = byteLength2 - 1, mul = 1, sub = 0;
    this[offset + i2] = value & 255;
    while (--i2 >= 0 && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i2 + 1] !== 0)
        sub = 1;
      this[offset + i2] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength2;
  };
  Buffer2.prototype.writeInt8 = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 1, 127, -128);
    if (value < 0)
      value = 255 + value + 1;
    return this[offset] = value & 255, offset + 1;
  };
  Buffer2.prototype.writeInt16LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 32767, -32768);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, offset + 2;
  };
  Buffer2.prototype.writeInt16BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 32767, -32768);
    return this[offset] = value >>> 8, this[offset + 1] = value & 255, offset + 2;
  };
  Buffer2.prototype.writeInt32LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 2147483647, -2147483648);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, this[offset + 2] = value >>> 16, this[offset + 3] = value >>> 24, offset + 4;
  };
  Buffer2.prototype.writeInt32BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 2147483647, -2147483648);
    if (value < 0)
      value = 4294967295 + value + 1;
    return this[offset] = value >>> 24, this[offset + 1] = value >>> 16, this[offset + 2] = value >>> 8, this[offset + 3] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeBigInt64LE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
  });
  Buffer2.prototype.writeBigInt64BE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
  });
  Buffer2.prototype.writeFloatLE = function(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer2.prototype.writeFloatBE = function(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  Buffer2.prototype.writeDoubleLE = function(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer2.prototype.writeDoubleBE = function(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer2.prototype.copy = function(target, targetStart, start, end) {
    if (!Buffer2.isBuffer(target))
      throw TypeError("argument should be a Buffer");
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0)
      throw RangeError("targetStart out of bounds");
    if (start < 0 || start >= this.length)
      throw RangeError("Index out of range");
    if (end < 0)
      throw RangeError("sourceEnd out of bounds");
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start)
      end = target.length - targetStart + start;
    let len2 = end - start;
    if (this === target && typeof Uint8Array.prototype.copyWithin === "function")
      this.copyWithin(targetStart, start, end);
    else
      Uint8Array.prototype.set.call(target, this.subarray(start, end), targetStart);
    return len2;
  };
  Buffer2.prototype.fill = function(val, start, end, encoding) {
    if (typeof val === "string") {
      if (typeof start === "string")
        encoding = start, start = 0, end = this.length;
      else if (typeof end === "string")
        encoding = end, end = this.length;
      if (encoding !== undefined && typeof encoding !== "string")
        throw TypeError("encoding must be a string");
      if (typeof encoding === "string" && !Buffer2.isEncoding(encoding))
        throw TypeError("Unknown encoding: " + encoding);
      if (val.length === 1) {
        let code2 = val.charCodeAt(0);
        if (encoding === "utf8" && code2 < 128 || encoding === "latin1")
          val = code2;
      }
    } else if (typeof val === "number")
      val = val & 255;
    else if (typeof val === "boolean")
      val = Number(val);
    if (start < 0 || this.length < start || this.length < end)
      throw RangeError("Out of range index");
    if (end <= start)
      return this;
    if (start = start >>> 0, end = end === undefined ? this.length : end >>> 0, !val)
      val = 0;
    let i2;
    if (typeof val === "number")
      for (i2 = start;i2 < end; ++i2)
        this[i2] = val;
    else {
      let bytes = Buffer2.isBuffer(val) ? val : Buffer2.from(val, encoding), len2 = bytes.length;
      if (len2 === 0)
        throw TypeError('The value "' + val + '" is invalid for argument "value"');
      for (i2 = 0;i2 < end - start; ++i2)
        this[i2 + start] = bytes[i2 % len2];
    }
    return this;
  };
  INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
  hexSliceLookupTable = function() {
    let table = Array(256);
    for (let i2 = 0;i2 < 16; ++i2) {
      let i16 = i2 * 16;
      for (let j = 0;j < 16; ++j)
        table[i16 + j] = "0123456789abcdef"[i2] + "0123456789abcdef"[j];
    }
    return table;
  }();
  resolveObjectURL = notimpl("resolveObjectURL");
  isUtf8 = notimpl("isUtf8");
  transcode = notimpl("transcode");
  buffer_default = Buffer2;
});

// node:string_decoder
var exports_string_decoder = {};
__export(exports_string_decoder, {
  default: () => $StringDecoder,
  StringDecoder: () => $StringDecoder
});
function _normalizeEncoding(enc) {
  if (!enc)
    return "utf8";
  var retried;
  while (true)
    switch (enc) {
      case "utf8":
      case "utf-8":
        return "utf8";
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return "utf16le";
      case "latin1":
      case "binary":
        return "latin1";
      case "base64":
      case "ascii":
      case "hex":
        return enc;
      default:
        if (retried)
          return;
        enc = ("" + enc).toLowerCase(), retried = true;
    }
}
function normalizeEncoding(enc) {
  var nenc = _normalizeEncoding(enc);
  if (typeof nenc !== "string" && (Buffer3.isEncoding === isEncoding || !isEncoding(enc)))
    throw Error("Unknown encoding: " + enc);
  return nenc || enc;
}
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  var nb;
  switch (this.encoding) {
    case "utf16le":
      this.text = utf16Text, this.end = utf16End, nb = 4;
      break;
    case "utf8":
      this.fillLast = utf8FillLast, nb = 4;
      break;
    case "base64":
      this.text = base64Text, this.end = base64End, nb = 3;
      break;
    default:
      this.write = simpleWrite, this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0, this.lastTotal = 0, this.lastChar = Buffer3.allocUnsafe(nb);
}
function utf8CheckByte(byte) {
  if (byte <= 127)
    return 0;
  else if (byte >> 5 === 6)
    return 2;
  else if (byte >> 4 === 14)
    return 3;
  else if (byte >> 3 === 30)
    return 4;
  return byte >> 6 === 2 ? -1 : -2;
}
function utf8CheckIncomplete(self2, buf, i2) {
  var j = buf.length - 1;
  if (j < i2)
    return 0;
  var nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0)
      self2.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i2 || nb === -2)
    return 0;
  if (nb = utf8CheckByte(buf[j]), nb >= 0) {
    if (nb > 0)
      self2.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i2 || nb === -2)
    return 0;
  if (nb = utf8CheckByte(buf[j]), nb >= 0) {
    if (nb > 0)
      if (nb === 2)
        nb = 0;
      else
        self2.lastNeed = nb - 3;
    return nb;
  }
  return 0;
}
function utf8CheckExtraBytes(self2, buf, p) {
  if ((buf[0] & 192) !== 128)
    return self2.lastNeed = 0, "�";
  if (self2.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 192) !== 128)
      return self2.lastNeed = 1, "�";
    if (self2.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 192) !== 128)
        return self2.lastNeed = 2, "�";
    }
  }
}
function utf8FillLast(buf) {
  var p = this.lastTotal - this.lastNeed, r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined)
    return r;
  if (this.lastNeed <= buf.length)
    return buf.copy(this.lastChar, p, 0, this.lastNeed), this.lastChar.toString(this.encoding, 0, this.lastTotal);
  buf.copy(this.lastChar, p, 0, buf.length), this.lastNeed -= buf.length;
}
function utf8Text(buf, i2) {
  var total = utf8CheckIncomplete(this, buf, i2);
  if (!this.lastNeed)
    return buf.toString("utf8", i2);
  this.lastTotal = total;
  var end = buf.length - (total - this.lastNeed);
  return buf.copy(this.lastChar, 0, end), buf.toString("utf8", i2, end);
}
function utf8End(buf) {
  var r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed)
    return r + "�";
  return r;
}
function utf16Text(buf, i2) {
  if ((buf.length - i2) % 2 === 0) {
    var r = buf.toString("utf16le", i2);
    if (r) {
      var c = r.charCodeAt(r.length - 1);
      if (c >= 55296 && c <= 56319)
        return this.lastNeed = 2, this.lastTotal = 4, this.lastChar[0] = buf[buf.length - 2], this.lastChar[1] = buf[buf.length - 1], r.slice(0, -1);
    }
    return r;
  }
  return this.lastNeed = 1, this.lastTotal = 2, this.lastChar[0] = buf[buf.length - 1], buf.toString("utf16le", i2, buf.length - 1);
}
function utf16End(buf) {
  var r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed) {
    var end = this.lastTotal - this.lastNeed;
    return r + this.lastChar.toString("utf16le", 0, end);
  }
  return r;
}
function base64Text(buf, i2) {
  var n = (buf.length - i2) % 3;
  if (n === 0)
    return buf.toString("base64", i2);
  if (this.lastNeed = 3 - n, this.lastTotal = 3, n === 1)
    this.lastChar[0] = buf[buf.length - 1];
  else
    this.lastChar[0] = buf[buf.length - 2], this.lastChar[1] = buf[buf.length - 1];
  return buf.toString("base64", i2, buf.length - n);
}
function base64End(buf) {
  var r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed)
    return r + this.lastChar.toString("base64", 0, 3 - this.lastNeed);
  return r;
}
function simpleWrite(buf) {
  return buf.toString(this.encoding);
}
function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : "";
}
var __commonJS2 = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports), require_safe_buffer, Buffer3, isEncoding, $StringDecoder;
var init_string_decoder = __esm(() => {
  require_safe_buffer = __commonJS2((exports, module) => {
    /*! safe-buffer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
    var buffer = (init_buffer(), __toCommonJS(exports_buffer)), Buffer3 = buffer.Buffer;
    function copyProps(src, dst) {
      for (var key in src)
        dst[key] = src[key];
    }
    if (Buffer3.from && Buffer3.alloc && Buffer3.allocUnsafe && Buffer3.allocUnsafeSlow)
      module.exports = buffer;
    else
      copyProps(buffer, exports), exports.Buffer = SafeBuffer;
    function SafeBuffer(arg, encodingOrOffset, length) {
      return Buffer3(arg, encodingOrOffset, length);
    }
    SafeBuffer.prototype = Object.create(Buffer3.prototype);
    copyProps(Buffer3, SafeBuffer);
    SafeBuffer.from = function(arg, encodingOrOffset, length) {
      if (typeof arg === "number")
        throw TypeError("Argument must not be a number");
      return Buffer3(arg, encodingOrOffset, length);
    };
    SafeBuffer.alloc = function(size, fill, encoding) {
      if (typeof size !== "number")
        throw TypeError("Argument must be a number");
      var buf = Buffer3(size);
      if (fill !== undefined)
        if (typeof encoding === "string")
          buf.fill(fill, encoding);
        else
          buf.fill(fill);
      else
        buf.fill(0);
      return buf;
    };
    SafeBuffer.allocUnsafe = function(size) {
      if (typeof size !== "number")
        throw TypeError("Argument must be a number");
      return Buffer3(size);
    };
    SafeBuffer.allocUnsafeSlow = function(size) {
      if (typeof size !== "number")
        throw TypeError("Argument must be a number");
      return buffer.SlowBuffer(size);
    };
  });
  Buffer3 = require_safe_buffer().Buffer;
  isEncoding = Buffer3.isEncoding || function(encoding) {
    switch (encoding = "" + encoding, encoding && encoding.toLowerCase()) {
      case "hex":
      case "utf8":
      case "utf-8":
      case "ascii":
      case "binary":
      case "base64":
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
      case "raw":
        return true;
      default:
        return false;
    }
  };
  $StringDecoder = StringDecoder;
  StringDecoder.prototype.write = function(buf) {
    if (buf.length === 0)
      return "";
    var r, i2;
    if (this.lastNeed) {
      if (r = this.fillLast(buf), r === undefined)
        return "";
      i2 = this.lastNeed, this.lastNeed = 0;
    } else
      i2 = 0;
    if (i2 < buf.length)
      return r ? r + this.text(buf, i2) : this.text(buf, i2);
    return r || "";
  };
  StringDecoder.prototype.end = utf8End;
  StringDecoder.prototype.text = utf8Text;
  StringDecoder.prototype.fillLast = function(buf) {
    if (this.lastNeed <= buf.length)
      return buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed), this.lastChar.toString(this.encoding, 0, this.lastTotal);
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length), this.lastNeed -= buf.length;
  };
});

// ../../../../Development/anvil/anvild/node_modules/inherits/inherits_browser.js
var require_inherits_browser = __commonJS((exports, module) => {
  if (typeof Object.create === "function") {
    module.exports = function inherits(ctor, superCtor) {
      if (superCtor) {
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
          constructor: {
            value: ctor,
            enumerable: false,
            writable: true,
            configurable: true
          }
        });
      }
    };
  } else {
    module.exports = function inherits(ctor, superCtor) {
      if (superCtor) {
        ctor.super_ = superCtor;
        var TempCtor = function() {};
        TempCtor.prototype = superCtor.prototype;
        ctor.prototype = new TempCtor;
        ctor.prototype.constructor = ctor;
      }
    };
  }
});

// node:events
var exports_events = {};
__export(exports_events, {
  setMaxListeners: () => setMaxListeners2,
  once: () => once2,
  listenerCount: () => listenerCount2,
  init: () => EventEmitter,
  getMaxListeners: () => getMaxListeners2,
  getEventListeners: () => getEventListeners,
  default: () => events_default,
  captureRejectionSymbol: () => captureRejectionSymbol,
  addAbortListener: () => addAbortListener,
  EventEmitter: () => EventEmitter
});
function emitError(emitter, args) {
  var { _events: events } = emitter;
  if (args[0] ??= Error("Unhandled error."), !events)
    throw args[0];
  var errorMonitor = events[kErrorMonitor];
  if (errorMonitor)
    for (var handler of ArrayPrototypeSlice.call(errorMonitor))
      handler.apply(emitter, args);
  var handlers = events.error;
  if (!handlers)
    throw args[0];
  for (var handler of ArrayPrototypeSlice.call(handlers))
    handler.apply(emitter, args);
  return true;
}
function addCatch(emitter, promise, type, args) {
  promise.then(undefined, function(err) {
    queueMicrotask(() => emitUnhandledRejectionOrErr(emitter, err, type, args));
  });
}
function emitUnhandledRejectionOrErr(emitter, err, type, args) {
  if (typeof emitter[kRejection] === "function")
    emitter[kRejection](err, type, ...args);
  else
    try {
      emitter[kCapture] = false, emitter.emit("error", err);
    } finally {
      emitter[kCapture] = true;
    }
}
function overflowWarning(emitter, type, handlers) {
  handlers.warned = true;
  let warn = Error(`Possible EventEmitter memory leak detected. ${handlers.length} ${String(type)} listeners added to [${emitter.constructor.name}]. Use emitter.setMaxListeners() to increase limit`);
  warn.name = "MaxListenersExceededWarning", warn.emitter = emitter, warn.type = type, warn.count = handlers.length, console.warn(warn);
}
function onceWrapper(type, listener, ...args) {
  this.removeListener(type, listener), listener.apply(this, args);
}
function once2(emitter, type, options) {
  var signal = options?.signal;
  if (validateAbortSignal(signal, "options.signal"), signal?.aborted)
    throw new AbortError(undefined, { cause: signal?.reason });
  let { resolve, reject, promise } = $newPromiseCapability(Promise), errorListener = (err) => {
    if (emitter.removeListener(type, resolver), signal != null)
      eventTargetAgnosticRemoveListener(signal, "abort", abortListener);
    reject(err);
  }, resolver = (...args) => {
    if (typeof emitter.removeListener === "function")
      emitter.removeListener("error", errorListener);
    if (signal != null)
      eventTargetAgnosticRemoveListener(signal, "abort", abortListener);
    resolve(args);
  };
  if (eventTargetAgnosticAddListener(emitter, type, resolver, { once: true }), type !== "error" && typeof emitter.once === "function")
    emitter.once("error", errorListener);
  function abortListener() {
    eventTargetAgnosticRemoveListener(emitter, type, resolver), eventTargetAgnosticRemoveListener(emitter, "error", errorListener), reject(new AbortError(undefined, { cause: signal?.reason }));
  }
  if (signal != null)
    eventTargetAgnosticAddListener(signal, "abort", abortListener, { once: true });
  return promise;
}
function getEventListeners(emitter, type) {
  return emitter.listeners(type);
}
function setMaxListeners2(n, ...eventTargets) {
  validateNumber2(n, "setMaxListeners", 0);
  var length;
  if (eventTargets && (length = eventTargets.length))
    for (let i2 = 0;i2 < length; i2++)
      eventTargets[i2].setMaxListeners(n);
  else
    defaultMaxListeners = n;
}
function listenerCount2(emitter, type) {
  return emitter.listenerCount(type);
}
function eventTargetAgnosticRemoveListener(emitter, name, listener, flags) {
  if (typeof emitter.removeListener === "function")
    emitter.removeListener(name, listener);
  else
    emitter.removeEventListener(name, listener, flags);
}
function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
  if (typeof emitter.on === "function")
    if (flags.once)
      emitter.once(name, listener);
    else
      emitter.on(name, listener);
  else
    emitter.addEventListener(name, listener, flags);
}
function ERR_INVALID_ARG_TYPE2(name, type, value) {
  let err = TypeError(`The "${name}" argument must be of type ${type}. Received ${value}`);
  return err.code = "ERR_INVALID_ARG_TYPE", err;
}
function ERR_OUT_OF_RANGE2(name, range, value) {
  let err = RangeError(`The "${name}" argument is out of range. It must be ${range}. Received ${value}`);
  return err.code = "ERR_OUT_OF_RANGE", err;
}
function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal)))
    throw ERR_INVALID_ARG_TYPE2(name, "AbortSignal", signal);
}
function validateNumber2(value, name, min, max) {
  if (typeof value !== "number")
    throw ERR_INVALID_ARG_TYPE2(name, "number", value);
  if (min != null && value < min || max != null && value > max || (min != null || max != null) && Number.isNaN(value))
    throw ERR_OUT_OF_RANGE2(name, `${min != null ? `>= ${min}` : ""}${min != null && max != null ? " && " : ""}${max != null ? `<= ${max}` : ""}`, value);
}
function checkListener(listener) {
  if (typeof listener !== "function")
    throw TypeError("The listener must be a function");
}
function validateBoolean(value, name) {
  if (typeof value !== "boolean")
    throw ERR_INVALID_ARG_TYPE2(name, "boolean", value);
}
function getMaxListeners2(emitterOrTarget) {
  return emitterOrTarget?._maxListeners ?? defaultMaxListeners;
}
function addAbortListener(signal, listener) {
  if (signal === undefined)
    throw ERR_INVALID_ARG_TYPE2("signal", "AbortSignal", signal);
  if (validateAbortSignal(signal, "signal"), typeof listener !== "function")
    throw ERR_INVALID_ARG_TYPE2("listener", "function", listener);
  let removeEventListener;
  if (signal.aborted)
    queueMicrotask(() => listener());
  else
    signal.addEventListener("abort", listener, { __proto__: null, once: true }), removeEventListener = () => {
      signal.removeEventListener("abort", listener);
    };
  return { __proto__: null, [Symbol.dispose]() {
    removeEventListener?.();
  } };
}
var SymbolFor, kCapture, kErrorMonitor, kMaxEventTargetListeners, kMaxEventTargetListenersWarned, kRejection, captureRejectionSymbol, ArrayPrototypeSlice, defaultMaxListeners = 10, EventEmitter = function(opts) {
  if (this._events === undefined || this._events === this.__proto__._events)
    this._events = { __proto__: null }, this._eventsCount = 0;
  if (this._maxListeners ??= undefined, this[kCapture] = opts?.captureRejections ? Boolean(opts?.captureRejections) : EventEmitterPrototype[kCapture])
    this.emit = emitWithRejectionCapture;
}, EventEmitterPrototype, emitWithoutRejectionCapture = function(type, ...args) {
  if (type === "error")
    return emitError(this, args);
  var { _events: events } = this;
  if (events === undefined)
    return false;
  var handlers = events[type];
  if (handlers === undefined)
    return false;
  let maybeClonedHandlers = handlers.length > 1 ? handlers.slice() : handlers;
  for (let i2 = 0, { length } = maybeClonedHandlers;i2 < length; i2++) {
    let handler = maybeClonedHandlers[i2];
    switch (args.length) {
      case 0:
        handler.call(this);
        break;
      case 1:
        handler.call(this, args[0]);
        break;
      case 2:
        handler.call(this, args[0], args[1]);
        break;
      case 3:
        handler.call(this, args[0], args[1], args[2]);
        break;
      default:
        handler.apply(this, args);
        break;
    }
  }
  return true;
}, emitWithRejectionCapture = function(type, ...args) {
  if (type === "error")
    return emitError(this, args);
  var { _events: events } = this;
  if (events === undefined)
    return false;
  var handlers = events[type];
  if (handlers === undefined)
    return false;
  let maybeClonedHandlers = handlers.length > 1 ? handlers.slice() : handlers;
  for (let i2 = 0, { length } = maybeClonedHandlers;i2 < length; i2++) {
    let handler = maybeClonedHandlers[i2], result;
    switch (args.length) {
      case 0:
        result = handler.call(this);
        break;
      case 1:
        result = handler.call(this, args[0]);
        break;
      case 2:
        result = handler.call(this, args[0], args[1]);
        break;
      case 3:
        result = handler.call(this, args[0], args[1], args[2]);
        break;
      default:
        result = handler.apply(this, args);
        break;
    }
    if (result !== undefined && typeof result?.then === "function" && result.then === Promise.prototype.then)
      addCatch(this, result, type, args);
  }
  return true;
}, AbortError, events_default;
var init_events = __esm(() => {
  SymbolFor = Symbol.for;
  kCapture = Symbol("kCapture");
  kErrorMonitor = SymbolFor("events.errorMonitor");
  kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
  kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");
  kRejection = SymbolFor("nodejs.rejection");
  captureRejectionSymbol = SymbolFor("nodejs.rejection");
  ArrayPrototypeSlice = Array.prototype.slice;
  EventEmitterPrototype = EventEmitter.prototype = {};
  EventEmitterPrototype._events = undefined;
  EventEmitterPrototype._eventsCount = 0;
  EventEmitterPrototype._maxListeners = undefined;
  EventEmitterPrototype.setMaxListeners = function(n) {
    return validateNumber2(n, "setMaxListeners", 0), this._maxListeners = n, this;
  };
  EventEmitterPrototype.constructor = EventEmitter;
  EventEmitterPrototype.getMaxListeners = function() {
    return this?._maxListeners ?? defaultMaxListeners;
  };
  EventEmitterPrototype.emit = emitWithoutRejectionCapture;
  EventEmitterPrototype.addListener = function(type, fn) {
    checkListener(fn);
    var events = this._events;
    if (!events)
      events = this._events = { __proto__: null }, this._eventsCount = 0;
    else if (events.newListener)
      this.emit("newListener", type, fn.listener ?? fn);
    var handlers = events[type];
    if (!handlers)
      events[type] = [fn], this._eventsCount++;
    else {
      handlers.push(fn);
      var m = this._maxListeners ?? defaultMaxListeners;
      if (m > 0 && handlers.length > m && !handlers.warned)
        overflowWarning(this, type, handlers);
    }
    return this;
  };
  EventEmitterPrototype.on = EventEmitterPrototype.addListener;
  EventEmitterPrototype.prependListener = function(type, fn) {
    checkListener(fn);
    var events = this._events;
    if (!events)
      events = this._events = { __proto__: null }, this._eventsCount = 0;
    else if (events.newListener)
      this.emit("newListener", type, fn.listener ?? fn);
    var handlers = events[type];
    if (!handlers)
      events[type] = [fn], this._eventsCount++;
    else {
      handlers.unshift(fn);
      var m = this._maxListeners ?? defaultMaxListeners;
      if (m > 0 && handlers.length > m && !handlers.warned)
        overflowWarning(this, type, handlers);
    }
    return this;
  };
  EventEmitterPrototype.once = function(type, fn) {
    checkListener(fn);
    let bound = onceWrapper.bind(this, type, fn);
    return bound.listener = fn, this.addListener(type, bound), this;
  };
  EventEmitterPrototype.prependOnceListener = function(type, fn) {
    checkListener(fn);
    let bound = onceWrapper.bind(this, type, fn);
    return bound.listener = fn, this.prependListener(type, bound), this;
  };
  EventEmitterPrototype.removeListener = function(type, fn) {
    checkListener(fn);
    var { _events: events } = this;
    if (!events)
      return this;
    var handlers = events[type];
    if (!handlers)
      return this;
    var length = handlers.length;
    let position = -1;
    for (let i2 = length - 1;i2 >= 0; i2--)
      if (handlers[i2] === fn || handlers[i2].listener === fn) {
        position = i2;
        break;
      }
    if (position < 0)
      return this;
    if (position === 0)
      handlers.shift();
    else
      handlers.splice(position, 1);
    if (handlers.length === 0)
      delete events[type], this._eventsCount--;
    return this;
  };
  EventEmitterPrototype.off = EventEmitterPrototype.removeListener;
  EventEmitterPrototype.removeAllListeners = function(type) {
    var { _events: events } = this;
    if (type && events) {
      if (events[type])
        delete events[type], this._eventsCount--;
    } else
      this._events = { __proto__: null };
    return this;
  };
  EventEmitterPrototype.listeners = function(type) {
    var { _events: events } = this;
    if (!events)
      return [];
    var handlers = events[type];
    if (!handlers)
      return [];
    return handlers.map((x) => x.listener ?? x);
  };
  EventEmitterPrototype.rawListeners = function(type) {
    var { _events } = this;
    if (!_events)
      return [];
    var handlers = _events[type];
    if (!handlers)
      return [];
    return handlers.slice();
  };
  EventEmitterPrototype.listenerCount = function(type) {
    var { _events: events } = this;
    if (!events)
      return 0;
    return events[type]?.length ?? 0;
  };
  EventEmitterPrototype.eventNames = function() {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
  };
  EventEmitterPrototype[kCapture] = false;
  AbortError = class AbortError extends Error {
    constructor(message = "The operation was aborted", options = undefined) {
      if (options !== undefined && typeof options !== "object")
        throw ERR_INVALID_ARG_TYPE2("options", "Object", options);
      super(message, options);
      this.code = "ABORT_ERR", this.name = "AbortError";
    }
  };
  Object.defineProperties(EventEmitter, { captureRejections: { get() {
    return EventEmitterPrototype[kCapture];
  }, set(value) {
    validateBoolean(value, "EventEmitter.captureRejections"), EventEmitterPrototype[kCapture] = value;
  }, enumerable: true }, defaultMaxListeners: { enumerable: true, get: () => {
    return defaultMaxListeners;
  }, set: (arg) => {
    validateNumber2(arg, "defaultMaxListeners", 0), defaultMaxListeners = arg;
  } }, kMaxEventTargetListeners: { value: kMaxEventTargetListeners, enumerable: false, configurable: false, writable: false }, kMaxEventTargetListenersWarned: { value: kMaxEventTargetListenersWarned, enumerable: false, configurable: false, writable: false } });
  Object.assign(EventEmitter, { once: once2, getEventListeners, getMaxListeners: getMaxListeners2, setMaxListeners: setMaxListeners2, EventEmitter, usingDomains: false, captureRejectionSymbol, errorMonitor: kErrorMonitor, addAbortListener, init: EventEmitter, listenerCount: listenerCount2 });
  events_default = EventEmitter;
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/stream-browser.js
var require_stream_browser = __commonJS((exports, module) => {
  module.exports = (init_events(), __toCommonJS(exports_events)).EventEmitter;
});

// node:util
var exports_util = {};
__export(exports_util, {
  types: () => types,
  promisify: () => promisify,
  log: () => log,
  isUndefined: () => isUndefined,
  isSymbol: () => isSymbol,
  isString: () => isString,
  isRegExp: () => isRegExp,
  isPrimitive: () => isPrimitive,
  isObject: () => isObject,
  isNumber: () => isNumber,
  isNullOrUndefined: () => isNullOrUndefined,
  isNull: () => isNull,
  isFunction: () => isFunction,
  isError: () => isError,
  isDate: () => isDate,
  isBuffer: () => isBuffer,
  isBoolean: () => isBoolean,
  isArray: () => isArray,
  inspect: () => inspect,
  inherits: () => inherits,
  format: () => format,
  deprecate: () => deprecate,
  default: () => util_default,
  debuglog: () => debuglog,
  callbackifyOnRejected: () => callbackifyOnRejected,
  callbackify: () => callbackify,
  _extend: () => _extend,
  TextEncoder: () => TextEncoder,
  TextDecoder: () => TextDecoder
});
function format(f, ...args) {
  if (!isString(f)) {
    var objects = [f];
    for (var i2 = 0;i2 < args.length; i2++)
      objects.push(inspect(args[i2]));
    return objects.join(" ");
  }
  var i2 = 0, len2 = args.length, str = String(f).replace(formatRegExp, function(x2) {
    if (x2 === "%%")
      return "%";
    if (i2 >= len2)
      return x2;
    switch (x2) {
      case "%s":
        return String(args[i2++]);
      case "%d":
        return Number(args[i2++]);
      case "%j":
        try {
          return JSON.stringify(args[i2++]);
        } catch (_) {
          return "[Circular]";
        }
      default:
        return x2;
    }
  });
  for (var x = args[i2];i2 < len2; x = args[++i2])
    if (isNull(x) || !isObject(x))
      str += " " + x;
    else
      str += " " + inspect(x);
  return str;
}
function deprecate(fn, msg) {
  if (typeof process > "u" || process?.noDeprecation === true)
    return fn;
  var warned = false;
  function deprecated(...args) {
    if (!warned) {
      if (process.throwDeprecation)
        throw Error(msg);
      else if (process.traceDeprecation)
        console.trace(msg);
      else
        console.error(msg);
      warned = true;
    }
    return fn.apply(this, ...args);
  }
  return deprecated;
}
function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];
  if (style)
    return "\x1B[" + inspect.colors[style][0] + "m" + str + "\x1B[" + inspect.colors[style][1] + "m";
  else
    return str;
}
function stylizeNoColor(str, styleType) {
  return str;
}
function arrayToHash(array) {
  var hash = {};
  return array.forEach(function(val, idx) {
    hash[val] = true;
  }), hash;
}
function formatValue(ctx, value, recurseTimes) {
  if (ctx.customInspect && value && isFunction(value.inspect) && value.inspect !== inspect && !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret))
      ret = formatValue(ctx, ret, recurseTimes);
    return ret;
  }
  var primitive = formatPrimitive(ctx, value);
  if (primitive)
    return primitive;
  var keys = Object.keys(value), visibleKeys = arrayToHash(keys);
  if (ctx.showHidden)
    keys = Object.getOwnPropertyNames(value);
  if (isError(value) && (keys.indexOf("message") >= 0 || keys.indexOf("description") >= 0))
    return formatError(value);
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ": " + value.name : "";
      return ctx.stylize("[Function" + name + "]", "special");
    }
    if (isRegExp(value))
      return ctx.stylize(RegExp.prototype.toString.call(value), "regexp");
    if (isDate(value))
      return ctx.stylize(Date.prototype.toString.call(value), "date");
    if (isError(value))
      return formatError(value);
  }
  var base = "", array = false, braces = ["{", "}"];
  if (isArray(value))
    array = true, braces = ["[", "]"];
  if (isFunction(value)) {
    var n = value.name ? ": " + value.name : "";
    base = " [Function" + n + "]";
  }
  if (isRegExp(value))
    base = " " + RegExp.prototype.toString.call(value);
  if (isDate(value))
    base = " " + Date.prototype.toUTCString.call(value);
  if (isError(value))
    base = " " + formatError(value);
  if (keys.length === 0 && (!array || value.length == 0))
    return braces[0] + base + braces[1];
  if (recurseTimes < 0)
    if (isRegExp(value))
      return ctx.stylize(RegExp.prototype.toString.call(value), "regexp");
    else
      return ctx.stylize("[Object]", "special");
  ctx.seen.push(value);
  var output;
  if (array)
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  else
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  return ctx.seen.pop(), reduceToSingleString(output, base, braces);
}
function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize("undefined", "undefined");
  if (isString(value)) {
    var simple = "'" + JSON.stringify(value).replace(/^"|"$/g, "").replace(/'/g, "\\'").replace(/\\"/g, '"') + "'";
    return ctx.stylize(simple, "string");
  }
  if (isNumber(value))
    return ctx.stylize("" + value, "number");
  if (isBoolean(value))
    return ctx.stylize("" + value, "boolean");
  if (isNull(value))
    return ctx.stylize("null", "null");
}
function formatError(value) {
  return "[" + Error.prototype.toString.call(value) + "]";
}
function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i2 = 0, l = value.length;i2 < l; ++i2)
    if (hasOwnProperty(value, String(i2)))
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, String(i2), true));
    else
      output.push("");
  return keys.forEach(function(key) {
    if (!key.match(/^\d+$/))
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys, key, true));
  }), output;
}
function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  if (desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] }, desc.get)
    if (desc.set)
      str = ctx.stylize("[Getter/Setter]", "special");
    else
      str = ctx.stylize("[Getter]", "special");
  else if (desc.set)
    str = ctx.stylize("[Setter]", "special");
  if (!hasOwnProperty(visibleKeys, key))
    name = "[" + key + "]";
  if (!str)
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes))
        str = formatValue(ctx, desc.value, null);
      else
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      if (str.indexOf(`
`) > -1)
        if (array)
          str = str.split(`
`).map(function(line) {
            return "  " + line;
          }).join(`
`).slice(2);
        else
          str = `
` + str.split(`
`).map(function(line) {
            return "   " + line;
          }).join(`
`);
    } else
      str = ctx.stylize("[Circular]", "special");
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/))
      return str;
    if (name = JSON.stringify("" + key), name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/))
      name = name.slice(1, -1), name = ctx.stylize(name, "name");
    else
      name = name.replace(/'/g, "\\'").replace(/\\"/g, '"').replace(/(^"|"$)/g, "'"), name = ctx.stylize(name, "string");
  }
  return name + ": " + str;
}
function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0, length = output.reduce(function(prev, cur) {
    if (numLinesEst++, cur.indexOf(`
`) >= 0)
      numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, "").length + 1;
  }, 0);
  if (length > 60)
    return braces[0] + (base === "" ? "" : base + `
 `) + " " + output.join(`,
  `) + " " + braces[1];
  return braces[0] + base + " " + output.join(", ") + " " + braces[1];
}
function isArray(ar) {
  return Array.isArray(ar);
}
function isBoolean(arg) {
  return typeof arg === "boolean";
}
function isNull(arg) {
  return arg === null;
}
function isNullOrUndefined(arg) {
  return arg == null;
}
function isNumber(arg) {
  return typeof arg === "number";
}
function isString(arg) {
  return typeof arg === "string";
}
function isSymbol(arg) {
  return typeof arg === "symbol";
}
function isUndefined(arg) {
  return arg === undefined;
}
function isRegExp(re) {
  return isObject(re) && objectToString(re) === "[object RegExp]";
}
function isObject(arg) {
  return typeof arg === "object" && arg !== null;
}
function isDate(d) {
  return isObject(d) && objectToString(d) === "[object Date]";
}
function isError(e) {
  return isObject(e) && (objectToString(e) === "[object Error]" || e instanceof Error);
}
function isFunction(arg) {
  return typeof arg === "function";
}
function isPrimitive(arg) {
  return arg === null || typeof arg === "boolean" || typeof arg === "number" || typeof arg === "string" || typeof arg === "symbol" || typeof arg > "u";
}
function isBuffer(arg) {
  return arg instanceof Buffer;
}
function objectToString(o) {
  return Object.prototype.toString.call(o);
}
function pad(n) {
  return n < 10 ? "0" + n.toString(10) : n.toString(10);
}
function timestamp() {
  var d = new Date, time = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(":");
  return [d.getDate(), months[d.getMonth()], time].join(" ");
}
function log(...args) {
  console.log("%s - %s", timestamp(), format.apply(null, args));
}
function inherits(ctor, superCtor) {
  if (superCtor)
    ctor.super_ = superCtor, ctor.prototype = Object.create(superCtor.prototype, { constructor: { value: ctor, enumerable: false, writable: true, configurable: true } });
}
function _extend(origin, add) {
  if (!add || !isObject(add))
    return origin;
  var keys = Object.keys(add), i2 = keys.length;
  while (i2--)
    origin[keys[i2]] = add[keys[i2]];
  return origin;
}
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}
function callbackifyOnRejected(reason, cb) {
  if (!reason) {
    var newReason = Error("Promise was rejected with a falsy value");
    newReason.reason = reason, reason = newReason;
  }
  return cb(reason);
}
function callbackify(original) {
  if (typeof original !== "function")
    throw TypeError('The "original" argument must be of type Function');
  function callbackified(...args) {
    var maybeCb = args.pop();
    if (typeof maybeCb !== "function")
      throw TypeError("The last argument must be of type Function");
    var self2 = this, cb = function(...args2) {
      return maybeCb.apply(self2, ...args2);
    };
    original.apply(this, args).then(function(ret) {
      process.nextTick(cb.bind(null, null, ret));
    }, function(rej) {
      process.nextTick(callbackifyOnRejected.bind(null, rej, cb));
    });
  }
  return Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original)), Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original)), callbackified;
}
var formatRegExp, debuglog, inspect, types = () => {}, months, promisify, TextEncoder, TextDecoder, util_default;
var init_util = __esm(() => {
  formatRegExp = /%[sdj%]/g;
  debuglog = ((debugs = {}, debugEnvRegex = {}, debugEnv) => ((debugEnv = typeof process < "u" && false) && (debugEnv = debugEnv.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*").replace(/,/g, "$|^").toUpperCase()), debugEnvRegex = new RegExp("^" + debugEnv + "$", "i"), (set) => {
    if (set = set.toUpperCase(), !debugs[set])
      if (debugEnvRegex.test(set))
        debugs[set] = function(...args) {
          console.error("%s: %s", set, pid, format.apply(null, ...args));
        };
      else
        debugs[set] = function() {};
    return debugs[set];
  }))();
  inspect = ((i2) => (i2.colors = { bold: [1, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], white: [37, 39], grey: [90, 39], black: [30, 39], blue: [34, 39], cyan: [36, 39], green: [32, 39], magenta: [35, 39], red: [31, 39], yellow: [33, 39] }, i2.styles = { special: "cyan", number: "yellow", boolean: "yellow", undefined: "grey", null: "bold", string: "green", date: "magenta", regexp: "red" }, i2.custom = Symbol.for("nodejs.util.inspect.custom"), i2))(function(obj, opts, ...rest) {
    var ctx = { seen: [], stylize: stylizeNoColor };
    if (rest.length >= 1)
      ctx.depth = rest[0];
    if (rest.length >= 2)
      ctx.colors = rest[1];
    if (isBoolean(opts))
      ctx.showHidden = opts;
    else if (opts)
      _extend(ctx, opts);
    if (isUndefined(ctx.showHidden))
      ctx.showHidden = false;
    if (isUndefined(ctx.depth))
      ctx.depth = 2;
    if (isUndefined(ctx.colors))
      ctx.colors = false;
    if (ctx.colors)
      ctx.stylize = stylizeWithColor;
    return formatValue(ctx, obj, ctx.depth);
  });
  months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  promisify = ((x) => (x.custom = Symbol.for("nodejs.util.promisify.custom"), x))(function(original) {
    if (typeof original !== "function")
      throw TypeError('The "original" argument must be of type Function');
    if (kCustomPromisifiedSymbol && original[kCustomPromisifiedSymbol]) {
      var fn = original[kCustomPromisifiedSymbol];
      if (typeof fn !== "function")
        throw TypeError('The "nodejs.util.promisify.custom" argument must be of type Function');
      return Object.defineProperty(fn, kCustomPromisifiedSymbol, { value: fn, enumerable: false, writable: false, configurable: true }), fn;
    }
    function fn(...args) {
      var promiseResolve, promiseReject, promise = new Promise(function(resolve, reject) {
        promiseResolve = resolve, promiseReject = reject;
      });
      args.push(function(err, value) {
        if (err)
          promiseReject(err);
        else
          promiseResolve(value);
      });
      try {
        original.apply(this, args);
      } catch (err) {
        promiseReject(err);
      }
      return promise;
    }
    if (Object.setPrototypeOf(fn, Object.getPrototypeOf(original)), kCustomPromisifiedSymbol)
      Object.defineProperty(fn, kCustomPromisifiedSymbol, { value: fn, enumerable: false, writable: false, configurable: true });
    return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  });
  ({ TextEncoder, TextDecoder } = globalThis);
  util_default = { TextEncoder, TextDecoder, promisify, log, inherits, _extend, callbackifyOnRejected, callbackify };
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/buffer_list.js
var require_buffer_list = __commonJS((exports, module) => {
  function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
      var symbols = Object.getOwnPropertySymbols(object);
      enumerableOnly && (symbols = symbols.filter(function(sym) {
        return Object.getOwnPropertyDescriptor(object, sym).enumerable;
      })), keys.push.apply(keys, symbols);
    }
    return keys;
  }
  function _objectSpread(target) {
    for (var i2 = 1;i2 < arguments.length; i2++) {
      var source = arguments[i2] != null ? arguments[i2] : {};
      i2 % 2 ? ownKeys(Object(source), true).forEach(function(key) {
        _defineProperty(target, key, source[key]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function(key) {
        Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
      });
    }
    return target;
  }
  function _defineProperty(obj, key, value) {
    key = _toPropertyKey(key);
    if (key in obj) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      obj[key] = value;
    }
    return obj;
  }
  function _classCallCheck(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  }
  function _defineProperties(target, props) {
    for (var i2 = 0;i2 < props.length; i2++) {
      var descriptor = props[i2];
      descriptor.enumerable = descriptor.enumerable || false;
      descriptor.configurable = true;
      if ("value" in descriptor)
        descriptor.writable = true;
      Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
    }
  }
  function _createClass(Constructor, protoProps, staticProps) {
    if (protoProps)
      _defineProperties(Constructor.prototype, protoProps);
    if (staticProps)
      _defineProperties(Constructor, staticProps);
    Object.defineProperty(Constructor, "prototype", { writable: false });
    return Constructor;
  }
  function _toPropertyKey(arg) {
    var key = _toPrimitive(arg, "string");
    return typeof key === "symbol" ? key : String(key);
  }
  function _toPrimitive(input, hint) {
    if (typeof input !== "object" || input === null)
      return input;
    var prim = input[Symbol.toPrimitive];
    if (prim !== undefined) {
      var res = prim.call(input, hint || "default");
      if (typeof res !== "object")
        return res;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(input);
  }
  var _require = (init_buffer(), __toCommonJS(exports_buffer));
  var Buffer4 = _require.Buffer;
  var _require2 = (init_util(), __toCommonJS(exports_util));
  var inspect2 = _require2.inspect;
  var custom = inspect2 && inspect2.custom || "inspect";
  function copyBuffer(src, target, offset) {
    Buffer4.prototype.copy.call(src, target, offset);
  }
  module.exports = /* @__PURE__ */ function() {
    function BufferList() {
      _classCallCheck(this, BufferList);
      this.head = null;
      this.tail = null;
      this.length = 0;
    }
    _createClass(BufferList, [{
      key: "push",
      value: function push(v) {
        var entry = {
          data: v,
          next: null
        };
        if (this.length > 0)
          this.tail.next = entry;
        else
          this.head = entry;
        this.tail = entry;
        ++this.length;
      }
    }, {
      key: "unshift",
      value: function unshift(v) {
        var entry = {
          data: v,
          next: this.head
        };
        if (this.length === 0)
          this.tail = entry;
        this.head = entry;
        ++this.length;
      }
    }, {
      key: "shift",
      value: function shift() {
        if (this.length === 0)
          return;
        var ret = this.head.data;
        if (this.length === 1)
          this.head = this.tail = null;
        else
          this.head = this.head.next;
        --this.length;
        return ret;
      }
    }, {
      key: "clear",
      value: function clear() {
        this.head = this.tail = null;
        this.length = 0;
      }
    }, {
      key: "join",
      value: function join(s) {
        if (this.length === 0)
          return "";
        var p = this.head;
        var ret = "" + p.data;
        while (p = p.next)
          ret += s + p.data;
        return ret;
      }
    }, {
      key: "concat",
      value: function concat(n) {
        if (this.length === 0)
          return Buffer4.alloc(0);
        var ret = Buffer4.allocUnsafe(n >>> 0);
        var p = this.head;
        var i2 = 0;
        while (p) {
          copyBuffer(p.data, ret, i2);
          i2 += p.data.length;
          p = p.next;
        }
        return ret;
      }
    }, {
      key: "consume",
      value: function consume(n, hasStrings) {
        var ret;
        if (n < this.head.data.length) {
          ret = this.head.data.slice(0, n);
          this.head.data = this.head.data.slice(n);
        } else if (n === this.head.data.length) {
          ret = this.shift();
        } else {
          ret = hasStrings ? this._getString(n) : this._getBuffer(n);
        }
        return ret;
      }
    }, {
      key: "first",
      value: function first() {
        return this.head.data;
      }
    }, {
      key: "_getString",
      value: function _getString(n) {
        var p = this.head;
        var c = 1;
        var ret = p.data;
        n -= ret.length;
        while (p = p.next) {
          var str = p.data;
          var nb = n > str.length ? str.length : n;
          if (nb === str.length)
            ret += str;
          else
            ret += str.slice(0, n);
          n -= nb;
          if (n === 0) {
            if (nb === str.length) {
              ++c;
              if (p.next)
                this.head = p.next;
              else
                this.head = this.tail = null;
            } else {
              this.head = p;
              p.data = str.slice(nb);
            }
            break;
          }
          ++c;
        }
        this.length -= c;
        return ret;
      }
    }, {
      key: "_getBuffer",
      value: function _getBuffer(n) {
        var ret = Buffer4.allocUnsafe(n);
        var p = this.head;
        var c = 1;
        p.data.copy(ret);
        n -= p.data.length;
        while (p = p.next) {
          var buf = p.data;
          var nb = n > buf.length ? buf.length : n;
          buf.copy(ret, ret.length - n, 0, nb);
          n -= nb;
          if (n === 0) {
            if (nb === buf.length) {
              ++c;
              if (p.next)
                this.head = p.next;
              else
                this.head = this.tail = null;
            } else {
              this.head = p;
              p.data = buf.slice(nb);
            }
            break;
          }
          ++c;
        }
        this.length -= c;
        return ret;
      }
    }, {
      key: custom,
      value: function value(_, options) {
        return inspect2(this, _objectSpread(_objectSpread({}, options), {}, {
          depth: 0,
          customInspect: false
        }));
      }
    }]);
    return BufferList;
  }();
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/destroy.js
var require_destroy = __commonJS((exports, module) => {
  function destroy(err, cb) {
    var _this = this;
    var readableDestroyed = this._readableState && this._readableState.destroyed;
    var writableDestroyed = this._writableState && this._writableState.destroyed;
    if (readableDestroyed || writableDestroyed) {
      if (cb) {
        cb(err);
      } else if (err) {
        if (!this._writableState) {
          process.nextTick(emitErrorNT, this, err);
        } else if (!this._writableState.errorEmitted) {
          this._writableState.errorEmitted = true;
          process.nextTick(emitErrorNT, this, err);
        }
      }
      return this;
    }
    if (this._readableState) {
      this._readableState.destroyed = true;
    }
    if (this._writableState) {
      this._writableState.destroyed = true;
    }
    this._destroy(err || null, function(err2) {
      if (!cb && err2) {
        if (!_this._writableState) {
          process.nextTick(emitErrorAndCloseNT, _this, err2);
        } else if (!_this._writableState.errorEmitted) {
          _this._writableState.errorEmitted = true;
          process.nextTick(emitErrorAndCloseNT, _this, err2);
        } else {
          process.nextTick(emitCloseNT, _this);
        }
      } else if (cb) {
        process.nextTick(emitCloseNT, _this);
        cb(err2);
      } else {
        process.nextTick(emitCloseNT, _this);
      }
    });
    return this;
  }
  function emitErrorAndCloseNT(self2, err) {
    emitErrorNT(self2, err);
    emitCloseNT(self2);
  }
  function emitCloseNT(self2) {
    if (self2._writableState && !self2._writableState.emitClose)
      return;
    if (self2._readableState && !self2._readableState.emitClose)
      return;
    self2.emit("close");
  }
  function undestroy() {
    if (this._readableState) {
      this._readableState.destroyed = false;
      this._readableState.reading = false;
      this._readableState.ended = false;
      this._readableState.endEmitted = false;
    }
    if (this._writableState) {
      this._writableState.destroyed = false;
      this._writableState.ended = false;
      this._writableState.ending = false;
      this._writableState.finalCalled = false;
      this._writableState.prefinished = false;
      this._writableState.finished = false;
      this._writableState.errorEmitted = false;
    }
  }
  function emitErrorNT(self2, err) {
    self2.emit("error", err);
  }
  function errorOrDestroy(stream, err) {
    var rState = stream._readableState;
    var wState = stream._writableState;
    if (rState && rState.autoDestroy || wState && wState.autoDestroy)
      stream.destroy(err);
    else
      stream.emit("error", err);
  }
  module.exports = {
    destroy,
    undestroy,
    errorOrDestroy
  };
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/errors-browser.js
var require_errors_browser = __commonJS((exports, module) => {
  function _inheritsLoose(subClass, superClass) {
    subClass.prototype = Object.create(superClass.prototype);
    subClass.prototype.constructor = subClass;
    subClass.__proto__ = superClass;
  }
  var codes = {};
  function createErrorType(code2, message, Base) {
    if (!Base) {
      Base = Error;
    }
    function getMessage(arg1, arg2, arg3) {
      if (typeof message === "string") {
        return message;
      } else {
        return message(arg1, arg2, arg3);
      }
    }
    var NodeError = /* @__PURE__ */ function(_Base) {
      _inheritsLoose(NodeError2, _Base);
      function NodeError2(arg1, arg2, arg3) {
        return _Base.call(this, getMessage(arg1, arg2, arg3)) || this;
      }
      return NodeError2;
    }(Base);
    NodeError.prototype.name = Base.name;
    NodeError.prototype.code = code2;
    codes[code2] = NodeError;
  }
  function oneOf(expected, thing) {
    if (Array.isArray(expected)) {
      var len2 = expected.length;
      expected = expected.map(function(i2) {
        return String(i2);
      });
      if (len2 > 2) {
        return "one of ".concat(thing, " ").concat(expected.slice(0, len2 - 1).join(", "), ", or ") + expected[len2 - 1];
      } else if (len2 === 2) {
        return "one of ".concat(thing, " ").concat(expected[0], " or ").concat(expected[1]);
      } else {
        return "of ".concat(thing, " ").concat(expected[0]);
      }
    } else {
      return "of ".concat(thing, " ").concat(String(expected));
    }
  }
  function startsWith(str, search, pos) {
    return str.substr(!pos || pos < 0 ? 0 : +pos, search.length) === search;
  }
  function endsWith(str, search, this_len) {
    if (this_len === undefined || this_len > str.length) {
      this_len = str.length;
    }
    return str.substring(this_len - search.length, this_len) === search;
  }
  function includes(str, search, start) {
    if (typeof start !== "number") {
      start = 0;
    }
    if (start + search.length > str.length) {
      return false;
    } else {
      return str.indexOf(search, start) !== -1;
    }
  }
  createErrorType("ERR_INVALID_OPT_VALUE", function(name, value) {
    return 'The value "' + value + '" is invalid for option "' + name + '"';
  }, TypeError);
  createErrorType("ERR_INVALID_ARG_TYPE", function(name, expected, actual) {
    var determiner;
    if (typeof expected === "string" && startsWith(expected, "not ")) {
      determiner = "must not be";
      expected = expected.replace(/^not /, "");
    } else {
      determiner = "must be";
    }
    var msg;
    if (endsWith(name, " argument")) {
      msg = "The ".concat(name, " ").concat(determiner, " ").concat(oneOf(expected, "type"));
    } else {
      var type = includes(name, ".") ? "property" : "argument";
      msg = 'The "'.concat(name, '" ').concat(type, " ").concat(determiner, " ").concat(oneOf(expected, "type"));
    }
    msg += ". Received type ".concat(typeof actual);
    return msg;
  }, TypeError);
  createErrorType("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
  createErrorType("ERR_METHOD_NOT_IMPLEMENTED", function(name) {
    return "The " + name + " method is not implemented";
  });
  createErrorType("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
  createErrorType("ERR_STREAM_DESTROYED", function(name) {
    return "Cannot call " + name + " after a stream was destroyed";
  });
  createErrorType("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
  createErrorType("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
  createErrorType("ERR_STREAM_WRITE_AFTER_END", "write after end");
  createErrorType("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError);
  createErrorType("ERR_UNKNOWN_ENCODING", function(arg) {
    return "Unknown encoding: " + arg;
  }, TypeError);
  createErrorType("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event");
  exports.codes = codes;
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/state.js
var require_state = __commonJS((exports, module) => {
  var ERR_INVALID_OPT_VALUE = require_errors_browser().codes.ERR_INVALID_OPT_VALUE;
  function highWaterMarkFrom(options, isDuplex, duplexKey) {
    return options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
  }
  function getHighWaterMark(state, options, duplexKey, isDuplex) {
    var hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
    if (hwm != null) {
      if (!(isFinite(hwm) && Math.floor(hwm) === hwm) || hwm < 0) {
        var name = isDuplex ? duplexKey : "highWaterMark";
        throw new ERR_INVALID_OPT_VALUE(name, hwm);
      }
      return Math.floor(hwm);
    }
    return state.objectMode ? 16 : 16 * 1024;
  }
  module.exports = {
    getHighWaterMark
  };
});

// ../../../../Development/anvil/anvild/node_modules/util-deprecate/browser.js
var require_browser = __commonJS((exports, module) => {
  module.exports = deprecate2;
  function deprecate2(fn, msg) {
    if (config("noDeprecation")) {
      return fn;
    }
    var warned = false;
    function deprecated() {
      if (!warned) {
        if (config("throwDeprecation")) {
          throw new Error(msg);
        } else if (config("traceDeprecation")) {
          console.trace(msg);
        } else {
          console.warn(msg);
        }
        warned = true;
      }
      return fn.apply(this, arguments);
    }
    return deprecated;
  }
  function config(name) {
    try {
      if (!global.localStorage)
        return false;
    } catch (_) {
      return false;
    }
    var val = global.localStorage[name];
    if (val == null)
      return false;
    return String(val).toLowerCase() === "true";
  }
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/_stream_writable.js
var require__stream_writable = __commonJS((exports, module) => {
  module.exports = Writable;
  function CorkedRequest(state) {
    var _this = this;
    this.next = null;
    this.entry = null;
    this.finish = function() {
      onCorkedFinish(_this, state);
    };
  }
  var Duplex;
  Writable.WritableState = WritableState;
  var internalUtil = {
    deprecate: require_browser()
  };
  var Stream = require_stream_browser();
  var Buffer4 = (init_buffer(), __toCommonJS(exports_buffer)).Buffer;
  var OurUint8Array = (typeof global !== "undefined" ? global : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : {}).Uint8Array || function() {};
  function _uint8ArrayToBuffer(chunk) {
    return Buffer4.from(chunk);
  }
  function _isUint8Array(obj) {
    return Buffer4.isBuffer(obj) || obj instanceof OurUint8Array;
  }
  var destroyImpl = require_destroy();
  var _require = require_state();
  var getHighWaterMark = _require.getHighWaterMark;
  var _require$codes = require_errors_browser().codes;
  var ERR_INVALID_ARG_TYPE3 = _require$codes.ERR_INVALID_ARG_TYPE;
  var ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED;
  var ERR_MULTIPLE_CALLBACK = _require$codes.ERR_MULTIPLE_CALLBACK;
  var ERR_STREAM_CANNOT_PIPE = _require$codes.ERR_STREAM_CANNOT_PIPE;
  var ERR_STREAM_DESTROYED = _require$codes.ERR_STREAM_DESTROYED;
  var ERR_STREAM_NULL_VALUES = _require$codes.ERR_STREAM_NULL_VALUES;
  var ERR_STREAM_WRITE_AFTER_END = _require$codes.ERR_STREAM_WRITE_AFTER_END;
  var ERR_UNKNOWN_ENCODING = _require$codes.ERR_UNKNOWN_ENCODING;
  var errorOrDestroy = destroyImpl.errorOrDestroy;
  require_inherits_browser()(Writable, Stream);
  function nop() {}
  function WritableState(options, stream, isDuplex) {
    Duplex = Duplex || require__stream_duplex();
    options = options || {};
    if (typeof isDuplex !== "boolean")
      isDuplex = stream instanceof Duplex;
    this.objectMode = !!options.objectMode;
    if (isDuplex)
      this.objectMode = this.objectMode || !!options.writableObjectMode;
    this.highWaterMark = getHighWaterMark(this, options, "writableHighWaterMark", isDuplex);
    this.finalCalled = false;
    this.needDrain = false;
    this.ending = false;
    this.ended = false;
    this.finished = false;
    this.destroyed = false;
    var noDecode = options.decodeStrings === false;
    this.decodeStrings = !noDecode;
    this.defaultEncoding = options.defaultEncoding || "utf8";
    this.length = 0;
    this.writing = false;
    this.corked = 0;
    this.sync = true;
    this.bufferProcessing = false;
    this.onwrite = function(er) {
      onwrite(stream, er);
    };
    this.writecb = null;
    this.writelen = 0;
    this.bufferedRequest = null;
    this.lastBufferedRequest = null;
    this.pendingcb = 0;
    this.prefinished = false;
    this.errorEmitted = false;
    this.emitClose = options.emitClose !== false;
    this.autoDestroy = !!options.autoDestroy;
    this.bufferedRequestCount = 0;
    this.corkedRequestsFree = new CorkedRequest(this);
  }
  WritableState.prototype.getBuffer = function getBuffer() {
    var current = this.bufferedRequest;
    var out = [];
    while (current) {
      out.push(current);
      current = current.next;
    }
    return out;
  };
  (function() {
    try {
      Object.defineProperty(WritableState.prototype, "buffer", {
        get: internalUtil.deprecate(function writableStateBufferGetter() {
          return this.getBuffer();
        }, "_writableState.buffer is deprecated. Use _writableState.getBuffer " + "instead.", "DEP0003")
      });
    } catch (_) {}
  })();
  var realHasInstance;
  if (typeof Symbol === "function" && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === "function") {
    realHasInstance = Function.prototype[Symbol.hasInstance];
    Object.defineProperty(Writable, Symbol.hasInstance, {
      value: function value(object) {
        if (realHasInstance.call(this, object))
          return true;
        if (this !== Writable)
          return false;
        return object && object._writableState instanceof WritableState;
      }
    });
  } else {
    realHasInstance = function realHasInstance2(object) {
      return object instanceof this;
    };
  }
  function Writable(options) {
    Duplex = Duplex || require__stream_duplex();
    var isDuplex = this instanceof Duplex;
    if (!isDuplex && !realHasInstance.call(Writable, this))
      return new Writable(options);
    this._writableState = new WritableState(options, this, isDuplex);
    this.writable = true;
    if (options) {
      if (typeof options.write === "function")
        this._write = options.write;
      if (typeof options.writev === "function")
        this._writev = options.writev;
      if (typeof options.destroy === "function")
        this._destroy = options.destroy;
      if (typeof options.final === "function")
        this._final = options.final;
    }
    Stream.call(this);
  }
  Writable.prototype.pipe = function() {
    errorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE);
  };
  function writeAfterEnd(stream, cb) {
    var er = new ERR_STREAM_WRITE_AFTER_END;
    errorOrDestroy(stream, er);
    process.nextTick(cb, er);
  }
  function validChunk(stream, state, chunk, cb) {
    var er;
    if (chunk === null) {
      er = new ERR_STREAM_NULL_VALUES;
    } else if (typeof chunk !== "string" && !state.objectMode) {
      er = new ERR_INVALID_ARG_TYPE3("chunk", ["string", "Buffer"], chunk);
    }
    if (er) {
      errorOrDestroy(stream, er);
      process.nextTick(cb, er);
      return false;
    }
    return true;
  }
  Writable.prototype.write = function(chunk, encoding, cb) {
    var state = this._writableState;
    var ret = false;
    var isBuf = !state.objectMode && _isUint8Array(chunk);
    if (isBuf && !Buffer4.isBuffer(chunk)) {
      chunk = _uint8ArrayToBuffer(chunk);
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = null;
    }
    if (isBuf)
      encoding = "buffer";
    else if (!encoding)
      encoding = state.defaultEncoding;
    if (typeof cb !== "function")
      cb = nop;
    if (state.ending)
      writeAfterEnd(this, cb);
    else if (isBuf || validChunk(this, state, chunk, cb)) {
      state.pendingcb++;
      ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
    }
    return ret;
  };
  Writable.prototype.cork = function() {
    this._writableState.corked++;
  };
  Writable.prototype.uncork = function() {
    var state = this._writableState;
    if (state.corked) {
      state.corked--;
      if (!state.writing && !state.corked && !state.bufferProcessing && state.bufferedRequest)
        clearBuffer(this, state);
    }
  };
  Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
    if (typeof encoding === "string")
      encoding = encoding.toLowerCase();
    if (!(["hex", "utf8", "utf-8", "ascii", "binary", "base64", "ucs2", "ucs-2", "utf16le", "utf-16le", "raw"].indexOf((encoding + "").toLowerCase()) > -1))
      throw new ERR_UNKNOWN_ENCODING(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
  };
  Object.defineProperty(Writable.prototype, "writableBuffer", {
    enumerable: false,
    get: function get() {
      return this._writableState && this._writableState.getBuffer();
    }
  });
  function decodeChunk(state, chunk, encoding) {
    if (!state.objectMode && state.decodeStrings !== false && typeof chunk === "string") {
      chunk = Buffer4.from(chunk, encoding);
    }
    return chunk;
  }
  Object.defineProperty(Writable.prototype, "writableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._writableState.highWaterMark;
    }
  });
  function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
    if (!isBuf) {
      var newChunk = decodeChunk(state, chunk, encoding);
      if (chunk !== newChunk) {
        isBuf = true;
        encoding = "buffer";
        chunk = newChunk;
      }
    }
    var len2 = state.objectMode ? 1 : chunk.length;
    state.length += len2;
    var ret = state.length < state.highWaterMark;
    if (!ret)
      state.needDrain = true;
    if (state.writing || state.corked) {
      var last = state.lastBufferedRequest;
      state.lastBufferedRequest = {
        chunk,
        encoding,
        isBuf,
        callback: cb,
        next: null
      };
      if (last) {
        last.next = state.lastBufferedRequest;
      } else {
        state.bufferedRequest = state.lastBufferedRequest;
      }
      state.bufferedRequestCount += 1;
    } else {
      doWrite(stream, state, false, len2, chunk, encoding, cb);
    }
    return ret;
  }
  function doWrite(stream, state, writev, len2, chunk, encoding, cb) {
    state.writelen = len2;
    state.writecb = cb;
    state.writing = true;
    state.sync = true;
    if (state.destroyed)
      state.onwrite(new ERR_STREAM_DESTROYED("write"));
    else if (writev)
      stream._writev(chunk, state.onwrite);
    else
      stream._write(chunk, encoding, state.onwrite);
    state.sync = false;
  }
  function onwriteError(stream, state, sync, er, cb) {
    --state.pendingcb;
    if (sync) {
      process.nextTick(cb, er);
      process.nextTick(finishMaybe, stream, state);
      stream._writableState.errorEmitted = true;
      errorOrDestroy(stream, er);
    } else {
      cb(er);
      stream._writableState.errorEmitted = true;
      errorOrDestroy(stream, er);
      finishMaybe(stream, state);
    }
  }
  function onwriteStateUpdate(state) {
    state.writing = false;
    state.writecb = null;
    state.length -= state.writelen;
    state.writelen = 0;
  }
  function onwrite(stream, er) {
    var state = stream._writableState;
    var sync = state.sync;
    var cb = state.writecb;
    if (typeof cb !== "function")
      throw new ERR_MULTIPLE_CALLBACK;
    onwriteStateUpdate(state);
    if (er)
      onwriteError(stream, state, sync, er, cb);
    else {
      var finished = needFinish(state) || stream.destroyed;
      if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
        clearBuffer(stream, state);
      }
      if (sync) {
        process.nextTick(afterWrite, stream, state, finished, cb);
      } else {
        afterWrite(stream, state, finished, cb);
      }
    }
  }
  function afterWrite(stream, state, finished, cb) {
    if (!finished)
      onwriteDrain(stream, state);
    state.pendingcb--;
    cb();
    finishMaybe(stream, state);
  }
  function onwriteDrain(stream, state) {
    if (state.length === 0 && state.needDrain) {
      state.needDrain = false;
      stream.emit("drain");
    }
  }
  function clearBuffer(stream, state) {
    state.bufferProcessing = true;
    var entry = state.bufferedRequest;
    if (stream._writev && entry && entry.next) {
      var l = state.bufferedRequestCount;
      var buffer = new Array(l);
      var holder = state.corkedRequestsFree;
      holder.entry = entry;
      var count = 0;
      var allBuffers = true;
      while (entry) {
        buffer[count] = entry;
        if (!entry.isBuf)
          allBuffers = false;
        entry = entry.next;
        count += 1;
      }
      buffer.allBuffers = allBuffers;
      doWrite(stream, state, true, state.length, buffer, "", holder.finish);
      state.pendingcb++;
      state.lastBufferedRequest = null;
      if (holder.next) {
        state.corkedRequestsFree = holder.next;
        holder.next = null;
      } else {
        state.corkedRequestsFree = new CorkedRequest(state);
      }
      state.bufferedRequestCount = 0;
    } else {
      while (entry) {
        var chunk = entry.chunk;
        var encoding = entry.encoding;
        var cb = entry.callback;
        var len2 = state.objectMode ? 1 : chunk.length;
        doWrite(stream, state, false, len2, chunk, encoding, cb);
        entry = entry.next;
        state.bufferedRequestCount--;
        if (state.writing) {
          break;
        }
      }
      if (entry === null)
        state.lastBufferedRequest = null;
    }
    state.bufferedRequest = entry;
    state.bufferProcessing = false;
  }
  Writable.prototype._write = function(chunk, encoding, cb) {
    cb(new ERR_METHOD_NOT_IMPLEMENTED("_write()"));
  };
  Writable.prototype._writev = null;
  Writable.prototype.end = function(chunk, encoding, cb) {
    var state = this._writableState;
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = null;
    }
    if (chunk !== null && chunk !== undefined)
      this.write(chunk, encoding);
    if (state.corked) {
      state.corked = 1;
      this.uncork();
    }
    if (!state.ending)
      endWritable(this, state, cb);
    return this;
  };
  Object.defineProperty(Writable.prototype, "writableLength", {
    enumerable: false,
    get: function get() {
      return this._writableState.length;
    }
  });
  function needFinish(state) {
    return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
  }
  function callFinal(stream, state) {
    stream._final(function(err) {
      state.pendingcb--;
      if (err) {
        errorOrDestroy(stream, err);
      }
      state.prefinished = true;
      stream.emit("prefinish");
      finishMaybe(stream, state);
    });
  }
  function prefinish(stream, state) {
    if (!state.prefinished && !state.finalCalled) {
      if (typeof stream._final === "function" && !state.destroyed) {
        state.pendingcb++;
        state.finalCalled = true;
        process.nextTick(callFinal, stream, state);
      } else {
        state.prefinished = true;
        stream.emit("prefinish");
      }
    }
  }
  function finishMaybe(stream, state) {
    var need = needFinish(state);
    if (need) {
      prefinish(stream, state);
      if (state.pendingcb === 0) {
        state.finished = true;
        stream.emit("finish");
        if (state.autoDestroy) {
          var rState = stream._readableState;
          if (!rState || rState.autoDestroy && rState.endEmitted) {
            stream.destroy();
          }
        }
      }
    }
    return need;
  }
  function endWritable(stream, state, cb) {
    state.ending = true;
    finishMaybe(stream, state);
    if (cb) {
      if (state.finished)
        process.nextTick(cb);
      else
        stream.once("finish", cb);
    }
    state.ended = true;
    stream.writable = false;
  }
  function onCorkedFinish(corkReq, state, err) {
    var entry = corkReq.entry;
    corkReq.entry = null;
    while (entry) {
      var cb = entry.callback;
      state.pendingcb--;
      cb(err);
      entry = entry.next;
    }
    state.corkedRequestsFree.next = corkReq;
  }
  Object.defineProperty(Writable.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._writableState === undefined) {
        return false;
      }
      return this._writableState.destroyed;
    },
    set: function set(value) {
      if (!this._writableState) {
        return;
      }
      this._writableState.destroyed = value;
    }
  });
  Writable.prototype.destroy = destroyImpl.destroy;
  Writable.prototype._undestroy = destroyImpl.undestroy;
  Writable.prototype._destroy = function(err, cb) {
    cb(err);
  };
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/_stream_duplex.js
var require__stream_duplex = __commonJS((exports, module) => {
  var objectKeys = Object.keys || function(obj) {
    var keys2 = [];
    for (var key in obj)
      keys2.push(key);
    return keys2;
  };
  module.exports = Duplex;
  var Readable = require__stream_readable();
  var Writable = require__stream_writable();
  require_inherits_browser()(Duplex, Readable);
  {
    keys = objectKeys(Writable.prototype);
    for (v = 0;v < keys.length; v++) {
      method = keys[v];
      if (!Duplex.prototype[method])
        Duplex.prototype[method] = Writable.prototype[method];
    }
  }
  var keys;
  var method;
  var v;
  function Duplex(options) {
    if (!(this instanceof Duplex))
      return new Duplex(options);
    Readable.call(this, options);
    Writable.call(this, options);
    this.allowHalfOpen = true;
    if (options) {
      if (options.readable === false)
        this.readable = false;
      if (options.writable === false)
        this.writable = false;
      if (options.allowHalfOpen === false) {
        this.allowHalfOpen = false;
        this.once("end", onend);
      }
    }
  }
  Object.defineProperty(Duplex.prototype, "writableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._writableState.highWaterMark;
    }
  });
  Object.defineProperty(Duplex.prototype, "writableBuffer", {
    enumerable: false,
    get: function get() {
      return this._writableState && this._writableState.getBuffer();
    }
  });
  Object.defineProperty(Duplex.prototype, "writableLength", {
    enumerable: false,
    get: function get() {
      return this._writableState.length;
    }
  });
  function onend() {
    if (this._writableState.ended)
      return;
    process.nextTick(onEndNT, this);
  }
  function onEndNT(self2) {
    self2.end();
  }
  Object.defineProperty(Duplex.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._readableState === undefined || this._writableState === undefined) {
        return false;
      }
      return this._readableState.destroyed && this._writableState.destroyed;
    },
    set: function set(value) {
      if (this._readableState === undefined || this._writableState === undefined) {
        return;
      }
      this._readableState.destroyed = value;
      this._writableState.destroyed = value;
    }
  });
});

// ../../../../Development/anvil/anvild/node_modules/safe-buffer/index.js
var require_safe_buffer2 = __commonJS((exports, module) => {
  /*! safe-buffer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  var buffer = (init_buffer(), __toCommonJS(exports_buffer));
  var Buffer4 = buffer.Buffer;
  function copyProps(src, dst) {
    for (var key in src) {
      dst[key] = src[key];
    }
  }
  if (Buffer4.from && Buffer4.alloc && Buffer4.allocUnsafe && Buffer4.allocUnsafeSlow) {
    module.exports = buffer;
  } else {
    copyProps(buffer, exports);
    exports.Buffer = SafeBuffer;
  }
  function SafeBuffer(arg, encodingOrOffset, length) {
    return Buffer4(arg, encodingOrOffset, length);
  }
  SafeBuffer.prototype = Object.create(Buffer4.prototype);
  copyProps(Buffer4, SafeBuffer);
  SafeBuffer.from = function(arg, encodingOrOffset, length) {
    if (typeof arg === "number") {
      throw new TypeError("Argument must not be a number");
    }
    return Buffer4(arg, encodingOrOffset, length);
  };
  SafeBuffer.alloc = function(size, fill, encoding) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    var buf = Buffer4(size);
    if (fill !== undefined) {
      if (typeof encoding === "string") {
        buf.fill(fill, encoding);
      } else {
        buf.fill(fill);
      }
    } else {
      buf.fill(0);
    }
    return buf;
  };
  SafeBuffer.allocUnsafe = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return Buffer4(size);
  };
  SafeBuffer.allocUnsafeSlow = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return buffer.SlowBuffer(size);
  };
});

// ../../../../Development/anvil/anvild/node_modules/string_decoder/lib/string_decoder.js
var require_string_decoder = __commonJS((exports) => {
  var Buffer4 = require_safe_buffer2().Buffer;
  var isEncoding2 = Buffer4.isEncoding || function(encoding) {
    encoding = "" + encoding;
    switch (encoding && encoding.toLowerCase()) {
      case "hex":
      case "utf8":
      case "utf-8":
      case "ascii":
      case "binary":
      case "base64":
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
      case "raw":
        return true;
      default:
        return false;
    }
  };
  function _normalizeEncoding2(enc) {
    if (!enc)
      return "utf8";
    var retried;
    while (true) {
      switch (enc) {
        case "utf8":
        case "utf-8":
          return "utf8";
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return "utf16le";
        case "latin1":
        case "binary":
          return "latin1";
        case "base64":
        case "ascii":
        case "hex":
          return enc;
        default:
          if (retried)
            return;
          enc = ("" + enc).toLowerCase();
          retried = true;
      }
    }
  }
  function normalizeEncoding2(enc) {
    var nenc = _normalizeEncoding2(enc);
    if (typeof nenc !== "string" && (Buffer4.isEncoding === isEncoding2 || !isEncoding2(enc)))
      throw new Error("Unknown encoding: " + enc);
    return nenc || enc;
  }
  exports.StringDecoder = StringDecoder2;
  function StringDecoder2(encoding) {
    this.encoding = normalizeEncoding2(encoding);
    var nb;
    switch (this.encoding) {
      case "utf16le":
        this.text = utf16Text2;
        this.end = utf16End2;
        nb = 4;
        break;
      case "utf8":
        this.fillLast = utf8FillLast2;
        nb = 4;
        break;
      case "base64":
        this.text = base64Text2;
        this.end = base64End2;
        nb = 3;
        break;
      default:
        this.write = simpleWrite2;
        this.end = simpleEnd2;
        return;
    }
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.lastChar = Buffer4.allocUnsafe(nb);
  }
  StringDecoder2.prototype.write = function(buf) {
    if (buf.length === 0)
      return "";
    var r;
    var i2;
    if (this.lastNeed) {
      r = this.fillLast(buf);
      if (r === undefined)
        return "";
      i2 = this.lastNeed;
      this.lastNeed = 0;
    } else {
      i2 = 0;
    }
    if (i2 < buf.length)
      return r ? r + this.text(buf, i2) : this.text(buf, i2);
    return r || "";
  };
  StringDecoder2.prototype.end = utf8End2;
  StringDecoder2.prototype.text = utf8Text2;
  StringDecoder2.prototype.fillLast = function(buf) {
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
    this.lastNeed -= buf.length;
  };
  function utf8CheckByte2(byte) {
    if (byte <= 127)
      return 0;
    else if (byte >> 5 === 6)
      return 2;
    else if (byte >> 4 === 14)
      return 3;
    else if (byte >> 3 === 30)
      return 4;
    return byte >> 6 === 2 ? -1 : -2;
  }
  function utf8CheckIncomplete2(self2, buf, i2) {
    var j = buf.length - 1;
    if (j < i2)
      return 0;
    var nb = utf8CheckByte2(buf[j]);
    if (nb >= 0) {
      if (nb > 0)
        self2.lastNeed = nb - 1;
      return nb;
    }
    if (--j < i2 || nb === -2)
      return 0;
    nb = utf8CheckByte2(buf[j]);
    if (nb >= 0) {
      if (nb > 0)
        self2.lastNeed = nb - 2;
      return nb;
    }
    if (--j < i2 || nb === -2)
      return 0;
    nb = utf8CheckByte2(buf[j]);
    if (nb >= 0) {
      if (nb > 0) {
        if (nb === 2)
          nb = 0;
        else
          self2.lastNeed = nb - 3;
      }
      return nb;
    }
    return 0;
  }
  function utf8CheckExtraBytes2(self2, buf, p) {
    if ((buf[0] & 192) !== 128) {
      self2.lastNeed = 0;
      return "�";
    }
    if (self2.lastNeed > 1 && buf.length > 1) {
      if ((buf[1] & 192) !== 128) {
        self2.lastNeed = 1;
        return "�";
      }
      if (self2.lastNeed > 2 && buf.length > 2) {
        if ((buf[2] & 192) !== 128) {
          self2.lastNeed = 2;
          return "�";
        }
      }
    }
  }
  function utf8FillLast2(buf) {
    var p = this.lastTotal - this.lastNeed;
    var r = utf8CheckExtraBytes2(this, buf, p);
    if (r !== undefined)
      return r;
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, p, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, p, 0, buf.length);
    this.lastNeed -= buf.length;
  }
  function utf8Text2(buf, i2) {
    var total = utf8CheckIncomplete2(this, buf, i2);
    if (!this.lastNeed)
      return buf.toString("utf8", i2);
    this.lastTotal = total;
    var end = buf.length - (total - this.lastNeed);
    buf.copy(this.lastChar, 0, end);
    return buf.toString("utf8", i2, end);
  }
  function utf8End2(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed)
      return r + "�";
    return r;
  }
  function utf16Text2(buf, i2) {
    if ((buf.length - i2) % 2 === 0) {
      var r = buf.toString("utf16le", i2);
      if (r) {
        var c = r.charCodeAt(r.length - 1);
        if (c >= 55296 && c <= 56319) {
          this.lastNeed = 2;
          this.lastTotal = 4;
          this.lastChar[0] = buf[buf.length - 2];
          this.lastChar[1] = buf[buf.length - 1];
          return r.slice(0, -1);
        }
      }
      return r;
    }
    this.lastNeed = 1;
    this.lastTotal = 2;
    this.lastChar[0] = buf[buf.length - 1];
    return buf.toString("utf16le", i2, buf.length - 1);
  }
  function utf16End2(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed) {
      var end = this.lastTotal - this.lastNeed;
      return r + this.lastChar.toString("utf16le", 0, end);
    }
    return r;
  }
  function base64Text2(buf, i2) {
    var n = (buf.length - i2) % 3;
    if (n === 0)
      return buf.toString("base64", i2);
    this.lastNeed = 3 - n;
    this.lastTotal = 3;
    if (n === 1) {
      this.lastChar[0] = buf[buf.length - 1];
    } else {
      this.lastChar[0] = buf[buf.length - 2];
      this.lastChar[1] = buf[buf.length - 1];
    }
    return buf.toString("base64", i2, buf.length - n);
  }
  function base64End2(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed)
      return r + this.lastChar.toString("base64", 0, 3 - this.lastNeed);
    return r;
  }
  function simpleWrite2(buf) {
    return buf.toString(this.encoding);
  }
  function simpleEnd2(buf) {
    return buf && buf.length ? this.write(buf) : "";
  }
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/end-of-stream.js
var require_end_of_stream = __commonJS((exports, module) => {
  var ERR_STREAM_PREMATURE_CLOSE = require_errors_browser().codes.ERR_STREAM_PREMATURE_CLOSE;
  function once(callback) {
    var called = false;
    return function() {
      if (called)
        return;
      called = true;
      for (var _len = arguments.length, args = new Array(_len), _key = 0;_key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      callback.apply(this, args);
    };
  }
  function noop() {}
  function isRequest(stream) {
    return stream.setHeader && typeof stream.abort === "function";
  }
  function eos(stream, opts, callback) {
    if (typeof opts === "function")
      return eos(stream, null, opts);
    if (!opts)
      opts = {};
    callback = once(callback || noop);
    var readable = opts.readable || opts.readable !== false && stream.readable;
    var writable = opts.writable || opts.writable !== false && stream.writable;
    var onlegacyfinish = function onlegacyfinish2() {
      if (!stream.writable)
        onfinish();
    };
    var writableEnded = stream._writableState && stream._writableState.finished;
    var onfinish = function onfinish2() {
      writable = false;
      writableEnded = true;
      if (!readable)
        callback.call(stream);
    };
    var readableEnded = stream._readableState && stream._readableState.endEmitted;
    var onend = function onend2() {
      readable = false;
      readableEnded = true;
      if (!writable)
        callback.call(stream);
    };
    var onerror = function onerror2(err) {
      callback.call(stream, err);
    };
    var onclose = function onclose2() {
      var err;
      if (readable && !readableEnded) {
        if (!stream._readableState || !stream._readableState.ended)
          err = new ERR_STREAM_PREMATURE_CLOSE;
        return callback.call(stream, err);
      }
      if (writable && !writableEnded) {
        if (!stream._writableState || !stream._writableState.ended)
          err = new ERR_STREAM_PREMATURE_CLOSE;
        return callback.call(stream, err);
      }
    };
    var onrequest = function onrequest2() {
      stream.req.on("finish", onfinish);
    };
    if (isRequest(stream)) {
      stream.on("complete", onfinish);
      stream.on("abort", onclose);
      if (stream.req)
        onrequest();
      else
        stream.on("request", onrequest);
    } else if (writable && !stream._writableState) {
      stream.on("end", onlegacyfinish);
      stream.on("close", onlegacyfinish);
    }
    stream.on("end", onend);
    stream.on("finish", onfinish);
    if (opts.error !== false)
      stream.on("error", onerror);
    stream.on("close", onclose);
    return function() {
      stream.removeListener("complete", onfinish);
      stream.removeListener("abort", onclose);
      stream.removeListener("request", onrequest);
      if (stream.req)
        stream.req.removeListener("finish", onfinish);
      stream.removeListener("end", onlegacyfinish);
      stream.removeListener("close", onlegacyfinish);
      stream.removeListener("finish", onfinish);
      stream.removeListener("end", onend);
      stream.removeListener("error", onerror);
      stream.removeListener("close", onclose);
    };
  }
  module.exports = eos;
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/async_iterator.js
var require_async_iterator = __commonJS((exports, module) => {
  var _Object$setPrototypeO;
  function _defineProperty(obj, key, value) {
    key = _toPropertyKey(key);
    if (key in obj) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      obj[key] = value;
    }
    return obj;
  }
  function _toPropertyKey(arg) {
    var key = _toPrimitive(arg, "string");
    return typeof key === "symbol" ? key : String(key);
  }
  function _toPrimitive(input, hint) {
    if (typeof input !== "object" || input === null)
      return input;
    var prim = input[Symbol.toPrimitive];
    if (prim !== undefined) {
      var res = prim.call(input, hint || "default");
      if (typeof res !== "object")
        return res;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(input);
  }
  var finished = require_end_of_stream();
  var kLastResolve = Symbol("lastResolve");
  var kLastReject = Symbol("lastReject");
  var kError = Symbol("error");
  var kEnded = Symbol("ended");
  var kLastPromise = Symbol("lastPromise");
  var kHandlePromise = Symbol("handlePromise");
  var kStream = Symbol("stream");
  function createIterResult(value, done) {
    return {
      value,
      done
    };
  }
  function readAndResolve(iter) {
    var resolve = iter[kLastResolve];
    if (resolve !== null) {
      var data = iter[kStream].read();
      if (data !== null) {
        iter[kLastPromise] = null;
        iter[kLastResolve] = null;
        iter[kLastReject] = null;
        resolve(createIterResult(data, false));
      }
    }
  }
  function onReadable(iter) {
    process.nextTick(readAndResolve, iter);
  }
  function wrapForNext(lastPromise, iter) {
    return function(resolve, reject) {
      lastPromise.then(function() {
        if (iter[kEnded]) {
          resolve(createIterResult(undefined, true));
          return;
        }
        iter[kHandlePromise](resolve, reject);
      }, reject);
    };
  }
  var AsyncIteratorPrototype = Object.getPrototypeOf(function() {});
  var ReadableStreamAsyncIteratorPrototype = Object.setPrototypeOf((_Object$setPrototypeO = {
    get stream() {
      return this[kStream];
    },
    next: function next() {
      var _this = this;
      var error = this[kError];
      if (error !== null) {
        return Promise.reject(error);
      }
      if (this[kEnded]) {
        return Promise.resolve(createIterResult(undefined, true));
      }
      if (this[kStream].destroyed) {
        return new Promise(function(resolve, reject) {
          process.nextTick(function() {
            if (_this[kError]) {
              reject(_this[kError]);
            } else {
              resolve(createIterResult(undefined, true));
            }
          });
        });
      }
      var lastPromise = this[kLastPromise];
      var promise;
      if (lastPromise) {
        promise = new Promise(wrapForNext(lastPromise, this));
      } else {
        var data = this[kStream].read();
        if (data !== null) {
          return Promise.resolve(createIterResult(data, false));
        }
        promise = new Promise(this[kHandlePromise]);
      }
      this[kLastPromise] = promise;
      return promise;
    }
  }, _defineProperty(_Object$setPrototypeO, Symbol.asyncIterator, function() {
    return this;
  }), _defineProperty(_Object$setPrototypeO, "return", function _return() {
    var _this2 = this;
    return new Promise(function(resolve, reject) {
      _this2[kStream].destroy(null, function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(createIterResult(undefined, true));
      });
    });
  }), _Object$setPrototypeO), AsyncIteratorPrototype);
  var createReadableStreamAsyncIterator = function createReadableStreamAsyncIterator2(stream) {
    var _Object$create;
    var iterator = Object.create(ReadableStreamAsyncIteratorPrototype, (_Object$create = {}, _defineProperty(_Object$create, kStream, {
      value: stream,
      writable: true
    }), _defineProperty(_Object$create, kLastResolve, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kLastReject, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kError, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kEnded, {
      value: stream._readableState.endEmitted,
      writable: true
    }), _defineProperty(_Object$create, kHandlePromise, {
      value: function value(resolve, reject) {
        var data = iterator[kStream].read();
        if (data) {
          iterator[kLastPromise] = null;
          iterator[kLastResolve] = null;
          iterator[kLastReject] = null;
          resolve(createIterResult(data, false));
        } else {
          iterator[kLastResolve] = resolve;
          iterator[kLastReject] = reject;
        }
      },
      writable: true
    }), _Object$create));
    iterator[kLastPromise] = null;
    finished(stream, function(err) {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        var reject = iterator[kLastReject];
        if (reject !== null) {
          iterator[kLastPromise] = null;
          iterator[kLastResolve] = null;
          iterator[kLastReject] = null;
          reject(err);
        }
        iterator[kError] = err;
        return;
      }
      var resolve = iterator[kLastResolve];
      if (resolve !== null) {
        iterator[kLastPromise] = null;
        iterator[kLastResolve] = null;
        iterator[kLastReject] = null;
        resolve(createIterResult(undefined, true));
      }
      iterator[kEnded] = true;
    });
    stream.on("readable", onReadable.bind(null, iterator));
    return iterator;
  };
  module.exports = createReadableStreamAsyncIterator;
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/from-browser.js
var require_from_browser = __commonJS((exports, module) => {
  module.exports = function() {
    throw new Error("Readable.from is not available in the browser");
  };
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/_stream_readable.js
var require__stream_readable = __commonJS((exports, module) => {
  module.exports = Readable;
  var Duplex;
  Readable.ReadableState = ReadableState;
  var EE = (init_events(), __toCommonJS(exports_events)).EventEmitter;
  var EElistenerCount = function EElistenerCount2(emitter, type) {
    return emitter.listeners(type).length;
  };
  var Stream = require_stream_browser();
  var Buffer4 = (init_buffer(), __toCommonJS(exports_buffer)).Buffer;
  var OurUint8Array = (typeof global !== "undefined" ? global : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : {}).Uint8Array || function() {};
  function _uint8ArrayToBuffer(chunk) {
    return Buffer4.from(chunk);
  }
  function _isUint8Array(obj) {
    return Buffer4.isBuffer(obj) || obj instanceof OurUint8Array;
  }
  var debugUtil = (init_util(), __toCommonJS(exports_util));
  var debug;
  if (debugUtil && debugUtil.debuglog) {
    debug = debugUtil.debuglog("stream");
  } else {
    debug = function debug2() {};
  }
  var BufferList = require_buffer_list();
  var destroyImpl = require_destroy();
  var _require = require_state();
  var getHighWaterMark = _require.getHighWaterMark;
  var _require$codes = require_errors_browser().codes;
  var ERR_INVALID_ARG_TYPE3 = _require$codes.ERR_INVALID_ARG_TYPE;
  var ERR_STREAM_PUSH_AFTER_EOF = _require$codes.ERR_STREAM_PUSH_AFTER_EOF;
  var ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED;
  var ERR_STREAM_UNSHIFT_AFTER_END_EVENT = _require$codes.ERR_STREAM_UNSHIFT_AFTER_END_EVENT;
  var StringDecoder2;
  var createReadableStreamAsyncIterator;
  var from2;
  require_inherits_browser()(Readable, Stream);
  var errorOrDestroy = destroyImpl.errorOrDestroy;
  var kProxyEvents = ["error", "close", "destroy", "pause", "resume"];
  function prependListener(emitter, event, fn) {
    if (typeof emitter.prependListener === "function")
      return emitter.prependListener(event, fn);
    if (!emitter._events || !emitter._events[event])
      emitter.on(event, fn);
    else if (Array.isArray(emitter._events[event]))
      emitter._events[event].unshift(fn);
    else
      emitter._events[event] = [fn, emitter._events[event]];
  }
  function ReadableState(options, stream, isDuplex) {
    Duplex = Duplex || require__stream_duplex();
    options = options || {};
    if (typeof isDuplex !== "boolean")
      isDuplex = stream instanceof Duplex;
    this.objectMode = !!options.objectMode;
    if (isDuplex)
      this.objectMode = this.objectMode || !!options.readableObjectMode;
    this.highWaterMark = getHighWaterMark(this, options, "readableHighWaterMark", isDuplex);
    this.buffer = new BufferList;
    this.length = 0;
    this.pipes = null;
    this.pipesCount = 0;
    this.flowing = null;
    this.ended = false;
    this.endEmitted = false;
    this.reading = false;
    this.sync = true;
    this.needReadable = false;
    this.emittedReadable = false;
    this.readableListening = false;
    this.resumeScheduled = false;
    this.paused = true;
    this.emitClose = options.emitClose !== false;
    this.autoDestroy = !!options.autoDestroy;
    this.destroyed = false;
    this.defaultEncoding = options.defaultEncoding || "utf8";
    this.awaitDrain = 0;
    this.readingMore = false;
    this.decoder = null;
    this.encoding = null;
    if (options.encoding) {
      if (!StringDecoder2)
        StringDecoder2 = require_string_decoder().StringDecoder;
      this.decoder = new StringDecoder2(options.encoding);
      this.encoding = options.encoding;
    }
  }
  function Readable(options) {
    Duplex = Duplex || require__stream_duplex();
    if (!(this instanceof Readable))
      return new Readable(options);
    var isDuplex = this instanceof Duplex;
    this._readableState = new ReadableState(options, this, isDuplex);
    this.readable = true;
    if (options) {
      if (typeof options.read === "function")
        this._read = options.read;
      if (typeof options.destroy === "function")
        this._destroy = options.destroy;
    }
    Stream.call(this);
  }
  Object.defineProperty(Readable.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._readableState === undefined) {
        return false;
      }
      return this._readableState.destroyed;
    },
    set: function set(value) {
      if (!this._readableState) {
        return;
      }
      this._readableState.destroyed = value;
    }
  });
  Readable.prototype.destroy = destroyImpl.destroy;
  Readable.prototype._undestroy = destroyImpl.undestroy;
  Readable.prototype._destroy = function(err, cb) {
    cb(err);
  };
  Readable.prototype.push = function(chunk, encoding) {
    var state = this._readableState;
    var skipChunkCheck;
    if (!state.objectMode) {
      if (typeof chunk === "string") {
        encoding = encoding || state.defaultEncoding;
        if (encoding !== state.encoding) {
          chunk = Buffer4.from(chunk, encoding);
          encoding = "";
        }
        skipChunkCheck = true;
      }
    } else {
      skipChunkCheck = true;
    }
    return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
  };
  Readable.prototype.unshift = function(chunk) {
    return readableAddChunk(this, chunk, null, true, false);
  };
  function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
    debug("readableAddChunk", chunk);
    var state = stream._readableState;
    if (chunk === null) {
      state.reading = false;
      onEofChunk(stream, state);
    } else {
      var er;
      if (!skipChunkCheck)
        er = chunkInvalid(state, chunk);
      if (er) {
        errorOrDestroy(stream, er);
      } else if (state.objectMode || chunk && chunk.length > 0) {
        if (typeof chunk !== "string" && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer4.prototype) {
          chunk = _uint8ArrayToBuffer(chunk);
        }
        if (addToFront) {
          if (state.endEmitted)
            errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT);
          else
            addChunk(stream, state, chunk, true);
        } else if (state.ended) {
          errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF);
        } else if (state.destroyed) {
          return false;
        } else {
          state.reading = false;
          if (state.decoder && !encoding) {
            chunk = state.decoder.write(chunk);
            if (state.objectMode || chunk.length !== 0)
              addChunk(stream, state, chunk, false);
            else
              maybeReadMore(stream, state);
          } else {
            addChunk(stream, state, chunk, false);
          }
        }
      } else if (!addToFront) {
        state.reading = false;
        maybeReadMore(stream, state);
      }
    }
    return !state.ended && (state.length < state.highWaterMark || state.length === 0);
  }
  function addChunk(stream, state, chunk, addToFront) {
    if (state.flowing && state.length === 0 && !state.sync) {
      state.awaitDrain = 0;
      stream.emit("data", chunk);
    } else {
      state.length += state.objectMode ? 1 : chunk.length;
      if (addToFront)
        state.buffer.unshift(chunk);
      else
        state.buffer.push(chunk);
      if (state.needReadable)
        emitReadable(stream);
    }
    maybeReadMore(stream, state);
  }
  function chunkInvalid(state, chunk) {
    var er;
    if (!_isUint8Array(chunk) && typeof chunk !== "string" && chunk !== undefined && !state.objectMode) {
      er = new ERR_INVALID_ARG_TYPE3("chunk", ["string", "Buffer", "Uint8Array"], chunk);
    }
    return er;
  }
  Readable.prototype.isPaused = function() {
    return this._readableState.flowing === false;
  };
  Readable.prototype.setEncoding = function(enc) {
    if (!StringDecoder2)
      StringDecoder2 = require_string_decoder().StringDecoder;
    var decoder = new StringDecoder2(enc);
    this._readableState.decoder = decoder;
    this._readableState.encoding = this._readableState.decoder.encoding;
    var p = this._readableState.buffer.head;
    var content = "";
    while (p !== null) {
      content += decoder.write(p.data);
      p = p.next;
    }
    this._readableState.buffer.clear();
    if (content !== "")
      this._readableState.buffer.push(content);
    this._readableState.length = content.length;
    return this;
  };
  var MAX_HWM = 1073741824;
  function computeNewHighWaterMark(n) {
    if (n >= MAX_HWM) {
      n = MAX_HWM;
    } else {
      n--;
      n |= n >>> 1;
      n |= n >>> 2;
      n |= n >>> 4;
      n |= n >>> 8;
      n |= n >>> 16;
      n++;
    }
    return n;
  }
  function howMuchToRead(n, state) {
    if (n <= 0 || state.length === 0 && state.ended)
      return 0;
    if (state.objectMode)
      return 1;
    if (n !== n) {
      if (state.flowing && state.length)
        return state.buffer.head.data.length;
      else
        return state.length;
    }
    if (n > state.highWaterMark)
      state.highWaterMark = computeNewHighWaterMark(n);
    if (n <= state.length)
      return n;
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    }
    return state.length;
  }
  Readable.prototype.read = function(n) {
    debug("read", n);
    n = parseInt(n, 10);
    var state = this._readableState;
    var nOrig = n;
    if (n !== 0)
      state.emittedReadable = false;
    if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
      debug("read: emitReadable", state.length, state.ended);
      if (state.length === 0 && state.ended)
        endReadable(this);
      else
        emitReadable(this);
      return null;
    }
    n = howMuchToRead(n, state);
    if (n === 0 && state.ended) {
      if (state.length === 0)
        endReadable(this);
      return null;
    }
    var doRead = state.needReadable;
    debug("need readable", doRead);
    if (state.length === 0 || state.length - n < state.highWaterMark) {
      doRead = true;
      debug("length less than watermark", doRead);
    }
    if (state.ended || state.reading) {
      doRead = false;
      debug("reading or ended", doRead);
    } else if (doRead) {
      debug("do read");
      state.reading = true;
      state.sync = true;
      if (state.length === 0)
        state.needReadable = true;
      this._read(state.highWaterMark);
      state.sync = false;
      if (!state.reading)
        n = howMuchToRead(nOrig, state);
    }
    var ret;
    if (n > 0)
      ret = fromList(n, state);
    else
      ret = null;
    if (ret === null) {
      state.needReadable = state.length <= state.highWaterMark;
      n = 0;
    } else {
      state.length -= n;
      state.awaitDrain = 0;
    }
    if (state.length === 0) {
      if (!state.ended)
        state.needReadable = true;
      if (nOrig !== n && state.ended)
        endReadable(this);
    }
    if (ret !== null)
      this.emit("data", ret);
    return ret;
  };
  function onEofChunk(stream, state) {
    debug("onEofChunk");
    if (state.ended)
      return;
    if (state.decoder) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) {
        state.buffer.push(chunk);
        state.length += state.objectMode ? 1 : chunk.length;
      }
    }
    state.ended = true;
    if (state.sync) {
      emitReadable(stream);
    } else {
      state.needReadable = false;
      if (!state.emittedReadable) {
        state.emittedReadable = true;
        emitReadable_(stream);
      }
    }
  }
  function emitReadable(stream) {
    var state = stream._readableState;
    debug("emitReadable", state.needReadable, state.emittedReadable);
    state.needReadable = false;
    if (!state.emittedReadable) {
      debug("emitReadable", state.flowing);
      state.emittedReadable = true;
      process.nextTick(emitReadable_, stream);
    }
  }
  function emitReadable_(stream) {
    var state = stream._readableState;
    debug("emitReadable_", state.destroyed, state.length, state.ended);
    if (!state.destroyed && (state.length || state.ended)) {
      stream.emit("readable");
      state.emittedReadable = false;
    }
    state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
    flow(stream);
  }
  function maybeReadMore(stream, state) {
    if (!state.readingMore) {
      state.readingMore = true;
      process.nextTick(maybeReadMore_, stream, state);
    }
  }
  function maybeReadMore_(stream, state) {
    while (!state.reading && !state.ended && (state.length < state.highWaterMark || state.flowing && state.length === 0)) {
      var len2 = state.length;
      debug("maybeReadMore read 0");
      stream.read(0);
      if (len2 === state.length)
        break;
    }
    state.readingMore = false;
  }
  Readable.prototype._read = function(n) {
    errorOrDestroy(this, new ERR_METHOD_NOT_IMPLEMENTED("_read()"));
  };
  Readable.prototype.pipe = function(dest, pipeOpts) {
    var src = this;
    var state = this._readableState;
    switch (state.pipesCount) {
      case 0:
        state.pipes = dest;
        break;
      case 1:
        state.pipes = [state.pipes, dest];
        break;
      default:
        state.pipes.push(dest);
        break;
    }
    state.pipesCount += 1;
    debug("pipe count=%d opts=%j", state.pipesCount, pipeOpts);
    var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
    var endFn = doEnd ? onend : unpipe;
    if (state.endEmitted)
      process.nextTick(endFn);
    else
      src.once("end", endFn);
    dest.on("unpipe", onunpipe);
    function onunpipe(readable, unpipeInfo) {
      debug("onunpipe");
      if (readable === src) {
        if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
          unpipeInfo.hasUnpiped = true;
          cleanup();
        }
      }
    }
    function onend() {
      debug("onend");
      dest.end();
    }
    var ondrain = pipeOnDrain(src);
    dest.on("drain", ondrain);
    var cleanedUp = false;
    function cleanup() {
      debug("cleanup");
      dest.removeListener("close", onclose);
      dest.removeListener("finish", onfinish);
      dest.removeListener("drain", ondrain);
      dest.removeListener("error", onerror);
      dest.removeListener("unpipe", onunpipe);
      src.removeListener("end", onend);
      src.removeListener("end", unpipe);
      src.removeListener("data", ondata);
      cleanedUp = true;
      if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain))
        ondrain();
    }
    src.on("data", ondata);
    function ondata(chunk) {
      debug("ondata");
      var ret = dest.write(chunk);
      debug("dest.write", ret);
      if (ret === false) {
        if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
          debug("false write response, pause", state.awaitDrain);
          state.awaitDrain++;
        }
        src.pause();
      }
    }
    function onerror(er) {
      debug("onerror", er);
      unpipe();
      dest.removeListener("error", onerror);
      if (EElistenerCount(dest, "error") === 0)
        errorOrDestroy(dest, er);
    }
    prependListener(dest, "error", onerror);
    function onclose() {
      dest.removeListener("finish", onfinish);
      unpipe();
    }
    dest.once("close", onclose);
    function onfinish() {
      debug("onfinish");
      dest.removeListener("close", onclose);
      unpipe();
    }
    dest.once("finish", onfinish);
    function unpipe() {
      debug("unpipe");
      src.unpipe(dest);
    }
    dest.emit("pipe", src);
    if (!state.flowing) {
      debug("pipe resume");
      src.resume();
    }
    return dest;
  };
  function pipeOnDrain(src) {
    return function pipeOnDrainFunctionResult() {
      var state = src._readableState;
      debug("pipeOnDrain", state.awaitDrain);
      if (state.awaitDrain)
        state.awaitDrain--;
      if (state.awaitDrain === 0 && EElistenerCount(src, "data")) {
        state.flowing = true;
        flow(src);
      }
    };
  }
  Readable.prototype.unpipe = function(dest) {
    var state = this._readableState;
    var unpipeInfo = {
      hasUnpiped: false
    };
    if (state.pipesCount === 0)
      return this;
    if (state.pipesCount === 1) {
      if (dest && dest !== state.pipes)
        return this;
      if (!dest)
        dest = state.pipes;
      state.pipes = null;
      state.pipesCount = 0;
      state.flowing = false;
      if (dest)
        dest.emit("unpipe", this, unpipeInfo);
      return this;
    }
    if (!dest) {
      var dests = state.pipes;
      var len2 = state.pipesCount;
      state.pipes = null;
      state.pipesCount = 0;
      state.flowing = false;
      for (var i2 = 0;i2 < len2; i2++)
        dests[i2].emit("unpipe", this, {
          hasUnpiped: false
        });
      return this;
    }
    var index = indexOf(state.pipes, dest);
    if (index === -1)
      return this;
    state.pipes.splice(index, 1);
    state.pipesCount -= 1;
    if (state.pipesCount === 1)
      state.pipes = state.pipes[0];
    dest.emit("unpipe", this, unpipeInfo);
    return this;
  };
  Readable.prototype.on = function(ev, fn) {
    var res = Stream.prototype.on.call(this, ev, fn);
    var state = this._readableState;
    if (ev === "data") {
      state.readableListening = this.listenerCount("readable") > 0;
      if (state.flowing !== false)
        this.resume();
    } else if (ev === "readable") {
      if (!state.endEmitted && !state.readableListening) {
        state.readableListening = state.needReadable = true;
        state.flowing = false;
        state.emittedReadable = false;
        debug("on readable", state.length, state.reading);
        if (state.length) {
          emitReadable(this);
        } else if (!state.reading) {
          process.nextTick(nReadingNextTick, this);
        }
      }
    }
    return res;
  };
  Readable.prototype.addListener = Readable.prototype.on;
  Readable.prototype.removeListener = function(ev, fn) {
    var res = Stream.prototype.removeListener.call(this, ev, fn);
    if (ev === "readable") {
      process.nextTick(updateReadableListening, this);
    }
    return res;
  };
  Readable.prototype.removeAllListeners = function(ev) {
    var res = Stream.prototype.removeAllListeners.apply(this, arguments);
    if (ev === "readable" || ev === undefined) {
      process.nextTick(updateReadableListening, this);
    }
    return res;
  };
  function updateReadableListening(self2) {
    var state = self2._readableState;
    state.readableListening = self2.listenerCount("readable") > 0;
    if (state.resumeScheduled && !state.paused) {
      state.flowing = true;
    } else if (self2.listenerCount("data") > 0) {
      self2.resume();
    }
  }
  function nReadingNextTick(self2) {
    debug("readable nexttick read 0");
    self2.read(0);
  }
  Readable.prototype.resume = function() {
    var state = this._readableState;
    if (!state.flowing) {
      debug("resume");
      state.flowing = !state.readableListening;
      resume(this, state);
    }
    state.paused = false;
    return this;
  };
  function resume(stream, state) {
    if (!state.resumeScheduled) {
      state.resumeScheduled = true;
      process.nextTick(resume_, stream, state);
    }
  }
  function resume_(stream, state) {
    debug("resume", state.reading);
    if (!state.reading) {
      stream.read(0);
    }
    state.resumeScheduled = false;
    stream.emit("resume");
    flow(stream);
    if (state.flowing && !state.reading)
      stream.read(0);
  }
  Readable.prototype.pause = function() {
    debug("call pause flowing=%j", this._readableState.flowing);
    if (this._readableState.flowing !== false) {
      debug("pause");
      this._readableState.flowing = false;
      this.emit("pause");
    }
    this._readableState.paused = true;
    return this;
  };
  function flow(stream) {
    var state = stream._readableState;
    debug("flow", state.flowing);
    while (state.flowing && stream.read() !== null)
      ;
  }
  Readable.prototype.wrap = function(stream) {
    var _this = this;
    var state = this._readableState;
    var paused = false;
    stream.on("end", function() {
      debug("wrapped end");
      if (state.decoder && !state.ended) {
        var chunk = state.decoder.end();
        if (chunk && chunk.length)
          _this.push(chunk);
      }
      _this.push(null);
    });
    stream.on("data", function(chunk) {
      debug("wrapped data");
      if (state.decoder)
        chunk = state.decoder.write(chunk);
      if (state.objectMode && (chunk === null || chunk === undefined))
        return;
      else if (!state.objectMode && (!chunk || !chunk.length))
        return;
      var ret = _this.push(chunk);
      if (!ret) {
        paused = true;
        stream.pause();
      }
    });
    for (var i2 in stream) {
      if (this[i2] === undefined && typeof stream[i2] === "function") {
        this[i2] = function methodWrap(method) {
          return function methodWrapReturnFunction() {
            return stream[method].apply(stream, arguments);
          };
        }(i2);
      }
    }
    for (var n = 0;n < kProxyEvents.length; n++) {
      stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
    }
    this._read = function(n2) {
      debug("wrapped _read", n2);
      if (paused) {
        paused = false;
        stream.resume();
      }
    };
    return this;
  };
  if (typeof Symbol === "function") {
    Readable.prototype[Symbol.asyncIterator] = function() {
      if (createReadableStreamAsyncIterator === undefined) {
        createReadableStreamAsyncIterator = require_async_iterator();
      }
      return createReadableStreamAsyncIterator(this);
    };
  }
  Object.defineProperty(Readable.prototype, "readableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._readableState.highWaterMark;
    }
  });
  Object.defineProperty(Readable.prototype, "readableBuffer", {
    enumerable: false,
    get: function get() {
      return this._readableState && this._readableState.buffer;
    }
  });
  Object.defineProperty(Readable.prototype, "readableFlowing", {
    enumerable: false,
    get: function get() {
      return this._readableState.flowing;
    },
    set: function set(state) {
      if (this._readableState) {
        this._readableState.flowing = state;
      }
    }
  });
  Readable._fromList = fromList;
  Object.defineProperty(Readable.prototype, "readableLength", {
    enumerable: false,
    get: function get() {
      return this._readableState.length;
    }
  });
  function fromList(n, state) {
    if (state.length === 0)
      return null;
    var ret;
    if (state.objectMode)
      ret = state.buffer.shift();
    else if (!n || n >= state.length) {
      if (state.decoder)
        ret = state.buffer.join("");
      else if (state.buffer.length === 1)
        ret = state.buffer.first();
      else
        ret = state.buffer.concat(state.length);
      state.buffer.clear();
    } else {
      ret = state.buffer.consume(n, state.decoder);
    }
    return ret;
  }
  function endReadable(stream) {
    var state = stream._readableState;
    debug("endReadable", state.endEmitted);
    if (!state.endEmitted) {
      state.ended = true;
      process.nextTick(endReadableNT, state, stream);
    }
  }
  function endReadableNT(state, stream) {
    debug("endReadableNT", state.endEmitted, state.length);
    if (!state.endEmitted && state.length === 0) {
      state.endEmitted = true;
      stream.readable = false;
      stream.emit("end");
      if (state.autoDestroy) {
        var wState = stream._writableState;
        if (!wState || wState.autoDestroy && wState.finished) {
          stream.destroy();
        }
      }
    }
  }
  if (typeof Symbol === "function") {
    Readable.from = function(iterable, opts) {
      if (from2 === undefined) {
        from2 = require_from_browser();
      }
      return from2(Readable, iterable, opts);
    };
  }
  function indexOf(xs, x) {
    for (var i2 = 0, l = xs.length;i2 < l; i2++) {
      if (xs[i2] === x)
        return i2;
    }
    return -1;
  }
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/_stream_transform.js
var require__stream_transform = __commonJS((exports, module) => {
  module.exports = Transform;
  var _require$codes = require_errors_browser().codes;
  var ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED;
  var ERR_MULTIPLE_CALLBACK = _require$codes.ERR_MULTIPLE_CALLBACK;
  var ERR_TRANSFORM_ALREADY_TRANSFORMING = _require$codes.ERR_TRANSFORM_ALREADY_TRANSFORMING;
  var ERR_TRANSFORM_WITH_LENGTH_0 = _require$codes.ERR_TRANSFORM_WITH_LENGTH_0;
  var Duplex = require__stream_duplex();
  require_inherits_browser()(Transform, Duplex);
  function afterTransform(er, data) {
    var ts = this._transformState;
    ts.transforming = false;
    var cb = ts.writecb;
    if (cb === null) {
      return this.emit("error", new ERR_MULTIPLE_CALLBACK);
    }
    ts.writechunk = null;
    ts.writecb = null;
    if (data != null)
      this.push(data);
    cb(er);
    var rs = this._readableState;
    rs.reading = false;
    if (rs.needReadable || rs.length < rs.highWaterMark) {
      this._read(rs.highWaterMark);
    }
  }
  function Transform(options) {
    if (!(this instanceof Transform))
      return new Transform(options);
    Duplex.call(this, options);
    this._transformState = {
      afterTransform: afterTransform.bind(this),
      needTransform: false,
      transforming: false,
      writecb: null,
      writechunk: null,
      writeencoding: null
    };
    this._readableState.needReadable = true;
    this._readableState.sync = false;
    if (options) {
      if (typeof options.transform === "function")
        this._transform = options.transform;
      if (typeof options.flush === "function")
        this._flush = options.flush;
    }
    this.on("prefinish", prefinish);
  }
  function prefinish() {
    var _this = this;
    if (typeof this._flush === "function" && !this._readableState.destroyed) {
      this._flush(function(er, data) {
        done(_this, er, data);
      });
    } else {
      done(this, null, null);
    }
  }
  Transform.prototype.push = function(chunk, encoding) {
    this._transformState.needTransform = false;
    return Duplex.prototype.push.call(this, chunk, encoding);
  };
  Transform.prototype._transform = function(chunk, encoding, cb) {
    cb(new ERR_METHOD_NOT_IMPLEMENTED("_transform()"));
  };
  Transform.prototype._write = function(chunk, encoding, cb) {
    var ts = this._transformState;
    ts.writecb = cb;
    ts.writechunk = chunk;
    ts.writeencoding = encoding;
    if (!ts.transforming) {
      var rs = this._readableState;
      if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark)
        this._read(rs.highWaterMark);
    }
  };
  Transform.prototype._read = function(n) {
    var ts = this._transformState;
    if (ts.writechunk !== null && !ts.transforming) {
      ts.transforming = true;
      this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
    } else {
      ts.needTransform = true;
    }
  };
  Transform.prototype._destroy = function(err, cb) {
    Duplex.prototype._destroy.call(this, err, function(err2) {
      cb(err2);
    });
  };
  function done(stream, er, data) {
    if (er)
      return stream.emit("error", er);
    if (data != null)
      stream.push(data);
    if (stream._writableState.length)
      throw new ERR_TRANSFORM_WITH_LENGTH_0;
    if (stream._transformState.transforming)
      throw new ERR_TRANSFORM_ALREADY_TRANSFORMING;
    return stream.push(null);
  }
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/_stream_passthrough.js
var require__stream_passthrough = __commonJS((exports, module) => {
  module.exports = PassThrough;
  var Transform = require__stream_transform();
  require_inherits_browser()(PassThrough, Transform);
  function PassThrough(options) {
    if (!(this instanceof PassThrough))
      return new PassThrough(options);
    Transform.call(this, options);
  }
  PassThrough.prototype._transform = function(chunk, encoding, cb) {
    cb(null, chunk);
  };
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/lib/internal/streams/pipeline.js
var require_pipeline = __commonJS((exports, module) => {
  var eos;
  function once(callback) {
    var called = false;
    return function() {
      if (called)
        return;
      called = true;
      callback.apply(undefined, arguments);
    };
  }
  var _require$codes = require_errors_browser().codes;
  var ERR_MISSING_ARGS = _require$codes.ERR_MISSING_ARGS;
  var ERR_STREAM_DESTROYED = _require$codes.ERR_STREAM_DESTROYED;
  function noop(err) {
    if (err)
      throw err;
  }
  function isRequest(stream) {
    return stream.setHeader && typeof stream.abort === "function";
  }
  function destroyer(stream, reading, writing, callback) {
    callback = once(callback);
    var closed = false;
    stream.on("close", function() {
      closed = true;
    });
    if (eos === undefined)
      eos = require_end_of_stream();
    eos(stream, {
      readable: reading,
      writable: writing
    }, function(err) {
      if (err)
        return callback(err);
      closed = true;
      callback();
    });
    var destroyed = false;
    return function(err) {
      if (closed)
        return;
      if (destroyed)
        return;
      destroyed = true;
      if (isRequest(stream))
        return stream.abort();
      if (typeof stream.destroy === "function")
        return stream.destroy();
      callback(err || new ERR_STREAM_DESTROYED("pipe"));
    };
  }
  function call(fn) {
    fn();
  }
  function pipe(from2, to) {
    return from2.pipe(to);
  }
  function popCallback(streams) {
    if (!streams.length)
      return noop;
    if (typeof streams[streams.length - 1] !== "function")
      return noop;
    return streams.pop();
  }
  function pipeline() {
    for (var _len = arguments.length, streams = new Array(_len), _key = 0;_key < _len; _key++) {
      streams[_key] = arguments[_key];
    }
    var callback = popCallback(streams);
    if (Array.isArray(streams[0]))
      streams = streams[0];
    if (streams.length < 2) {
      throw new ERR_MISSING_ARGS("streams");
    }
    var error;
    var destroys = streams.map(function(stream, i2) {
      var reading = i2 < streams.length - 1;
      var writing = i2 > 0;
      return destroyer(stream, reading, writing, function(err) {
        if (!error)
          error = err;
        if (err)
          destroys.forEach(call);
        if (reading)
          return;
        destroys.forEach(call);
        callback(error);
      });
    });
    return streams.reduce(pipe);
  }
  module.exports = pipeline;
});

// ../../../../Development/anvil/anvild/node_modules/readable-stream/readable-browser.js
var require_readable_browser = __commonJS((exports, module) => {
  exports = module.exports = require__stream_readable();
  exports.Stream = exports;
  exports.Readable = exports;
  exports.Writable = require__stream_writable();
  exports.Duplex = require__stream_duplex();
  exports.Transform = require__stream_transform();
  exports.PassThrough = require__stream_passthrough();
  exports.finished = require_end_of_stream();
  exports.pipeline = require_pipeline();
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_determine-filetype.js
var require__determine_filetype = __commonJS((exports, module) => {
  var determine = function(chunk, start, LIMIT) {
    var limit = Math.min(LIMIT - start, chunk.length);
    var current = [];
    var filetype = null;
    var index = -1;
    while (!filetype && ++index < limit) {
      var c = chunk[index];
      if (c === `
`) {
        if (current.length + index) {
          filetype = "drill";
          current = [];
        }
      } else {
        current.push(c);
        if (c === "*" && current[0] !== ";") {
          filetype = "gerber";
          current = [];
        }
      }
    }
    return filetype;
  };
  module.exports = determine;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/get-next-block.js
var require_get_next_block = __commonJS((exports, module) => {
  var getNext = function(type, chunk, start) {
    if (type !== "gerber" && type !== "drill") {
      throw new Error('filetype to get next block must be "drill" or "gerber"');
    }
    var limit = chunk.length - start;
    var split = type === "gerber" ? "*" : `
`;
    var param = type === "gerber" ? "%" : "";
    var splitFound = false;
    var paramStarted = false;
    var paramFound = false;
    var blockFound = false;
    var found = [];
    var read2 = 0;
    var lines = 0;
    while (!blockFound && read2 < limit) {
      var c = chunk[start + read2];
      if (c === `
`) {
        lines++;
      }
      if (c === param) {
        if (!paramStarted) {
          paramStarted = true;
          found.push(c);
        } else {
          paramFound = true;
          found.pop();
        }
      } else if (c === split) {
        splitFound = true;
        if (paramStarted) {
          found.push(c);
        }
      } else if (c >= " " && c <= "~") {
        found.push(c);
      }
      read2++;
      blockFound = splitFound && (!paramStarted || paramFound);
    }
    var block = blockFound ? found.join("").trim() : "";
    var rem = !blockFound ? found.join("") : "";
    return { lines, read: read2, block, rem };
  };
  module.exports = getNext;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_commands.js
var require__commands = __commonJS((exports, module) => {
  var done = function(line) {
    return { type: "done", line: line || -1 };
  };
  var set = function(property, value, line) {
    return { type: "set", line: line || -1, prop: property, value };
  };
  var level = function(level2, value, line) {
    return { type: "level", line: line || -1, level: level2, value };
  };
  var tool = function(code2, tool2, line) {
    return { type: "tool", line: line || -1, code: code2, tool: tool2 };
  };
  var op = function(operation, location, line) {
    return { type: "op", line: line || -1, op: operation, coord: location };
  };
  var macro = function(name, blocks, line) {
    return { type: "macro", line: line || -1, name, blocks };
  };
  var commandMap = {
    set,
    done,
    level,
    tool,
    op,
    macro
  };
  module.exports = commandMap;
});

// ../../../../Development/anvil/anvild/node_modules/lodash.padstart/index.js
var require_lodash2 = __commonJS((exports, module) => {
  var INFINITY = 1 / 0;
  var MAX_SAFE_INTEGER = 9007199254740991;
  var MAX_INTEGER = 179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;
  var NAN = 0 / 0;
  var symbolTag = "[object Symbol]";
  var reTrim = /^\s+|\s+$/g;
  var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
  var reIsBinary = /^0b[01]+$/i;
  var reIsOctal = /^0o[0-7]+$/i;
  var rsAstralRange = "\\ud800-\\udfff";
  var rsComboMarksRange = "\\u0300-\\u036f\\ufe20-\\ufe23";
  var rsComboSymbolsRange = "\\u20d0-\\u20f0";
  var rsVarRange = "\\ufe0e\\ufe0f";
  var rsAstral = "[" + rsAstralRange + "]";
  var rsCombo = "[" + rsComboMarksRange + rsComboSymbolsRange + "]";
  var rsFitz = "\\ud83c[\\udffb-\\udfff]";
  var rsModifier = "(?:" + rsCombo + "|" + rsFitz + ")";
  var rsNonAstral = "[^" + rsAstralRange + "]";
  var rsRegional = "(?:\\ud83c[\\udde6-\\uddff]){2}";
  var rsSurrPair = "[\\ud800-\\udbff][\\udc00-\\udfff]";
  var rsZWJ = "\\u200d";
  var reOptMod = rsModifier + "?";
  var rsOptVar = "[" + rsVarRange + "]?";
  var rsOptJoin = "(?:" + rsZWJ + "(?:" + [rsNonAstral, rsRegional, rsSurrPair].join("|") + ")" + rsOptVar + reOptMod + ")*";
  var rsSeq = rsOptVar + reOptMod + rsOptJoin;
  var rsSymbol = "(?:" + [rsNonAstral + rsCombo + "?", rsCombo, rsRegional, rsSurrPair, rsAstral].join("|") + ")";
  var reUnicode = RegExp(rsFitz + "(?=" + rsFitz + ")|" + rsSymbol + rsSeq, "g");
  var reHasUnicode = RegExp("[" + rsZWJ + rsAstralRange + rsComboMarksRange + rsComboSymbolsRange + rsVarRange + "]");
  var freeParseInt = parseInt;
  var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
  var freeSelf = typeof self == "object" && self && self.Object === Object && self;
  var root = freeGlobal || freeSelf || Function("return this")();
  var asciiSize = baseProperty("length");
  function asciiToArray(string) {
    return string.split("");
  }
  function baseProperty(key) {
    return function(object) {
      return object == null ? undefined : object[key];
    };
  }
  function hasUnicode(string) {
    return reHasUnicode.test(string);
  }
  function stringSize(string) {
    return hasUnicode(string) ? unicodeSize(string) : asciiSize(string);
  }
  function stringToArray(string) {
    return hasUnicode(string) ? unicodeToArray(string) : asciiToArray(string);
  }
  function unicodeSize(string) {
    var result = reUnicode.lastIndex = 0;
    while (reUnicode.test(string)) {
      result++;
    }
    return result;
  }
  function unicodeToArray(string) {
    return string.match(reUnicode) || [];
  }
  var objectProto = Object.prototype;
  var objectToString2 = objectProto.toString;
  var Symbol2 = root.Symbol;
  var nativeCeil = Math.ceil;
  var nativeFloor = Math.floor;
  var symbolProto = Symbol2 ? Symbol2.prototype : undefined;
  var symbolToString = symbolProto ? symbolProto.toString : undefined;
  function baseRepeat(string, n) {
    var result = "";
    if (!string || n < 1 || n > MAX_SAFE_INTEGER) {
      return result;
    }
    do {
      if (n % 2) {
        result += string;
      }
      n = nativeFloor(n / 2);
      if (n) {
        string += string;
      }
    } while (n);
    return result;
  }
  function baseSlice(array, start, end) {
    var index = -1, length = array.length;
    if (start < 0) {
      start = -start > length ? 0 : length + start;
    }
    end = end > length ? length : end;
    if (end < 0) {
      end += length;
    }
    length = start > end ? 0 : end - start >>> 0;
    start >>>= 0;
    var result = Array(length);
    while (++index < length) {
      result[index] = array[index + start];
    }
    return result;
  }
  function baseToString(value) {
    if (typeof value == "string") {
      return value;
    }
    if (isSymbol2(value)) {
      return symbolToString ? symbolToString.call(value) : "";
    }
    var result = value + "";
    return result == "0" && 1 / value == -INFINITY ? "-0" : result;
  }
  function castSlice(array, start, end) {
    var length = array.length;
    end = end === undefined ? length : end;
    return !start && end >= length ? array : baseSlice(array, start, end);
  }
  function createPadding(length, chars) {
    chars = chars === undefined ? " " : baseToString(chars);
    var charsLength = chars.length;
    if (charsLength < 2) {
      return charsLength ? baseRepeat(chars, length) : chars;
    }
    var result = baseRepeat(chars, nativeCeil(length / stringSize(chars)));
    return hasUnicode(chars) ? castSlice(stringToArray(result), 0, length).join("") : result.slice(0, length);
  }
  function isObject2(value) {
    var type = typeof value;
    return !!value && (type == "object" || type == "function");
  }
  function isObjectLike(value) {
    return !!value && typeof value == "object";
  }
  function isSymbol2(value) {
    return typeof value == "symbol" || isObjectLike(value) && objectToString2.call(value) == symbolTag;
  }
  function toFinite(value) {
    if (!value) {
      return value === 0 ? value : 0;
    }
    value = toNumber(value);
    if (value === INFINITY || value === -INFINITY) {
      var sign = value < 0 ? -1 : 1;
      return sign * MAX_INTEGER;
    }
    return value === value ? value : 0;
  }
  function toInteger(value) {
    var result = toFinite(value), remainder = result % 1;
    return result === result ? remainder ? result - remainder : result : 0;
  }
  function toNumber(value) {
    if (typeof value == "number") {
      return value;
    }
    if (isSymbol2(value)) {
      return NAN;
    }
    if (isObject2(value)) {
      var other = typeof value.valueOf == "function" ? value.valueOf() : value;
      value = isObject2(other) ? other + "" : other;
    }
    if (typeof value != "string") {
      return value === 0 ? value : +value;
    }
    value = value.replace(reTrim, "");
    var isBinary = reIsBinary.test(value);
    return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
  }
  function toString(value) {
    return value == null ? "" : baseToString(value);
  }
  function padStart(string, length, chars) {
    string = toString(string);
    length = toInteger(length);
    var strLength = length ? stringSize(string) : 0;
    return length && strLength < length ? createPadding(length - strLength, chars) + string : string;
  }
  module.exports = padStart;
});

// ../../../../Development/anvil/anvild/node_modules/lodash.padend/index.js
var require_lodash3 = __commonJS((exports, module) => {
  var INFINITY = 1 / 0;
  var MAX_SAFE_INTEGER = 9007199254740991;
  var MAX_INTEGER = 179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;
  var NAN = 0 / 0;
  var symbolTag = "[object Symbol]";
  var reTrim = /^\s+|\s+$/g;
  var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
  var reIsBinary = /^0b[01]+$/i;
  var reIsOctal = /^0o[0-7]+$/i;
  var rsAstralRange = "\\ud800-\\udfff";
  var rsComboMarksRange = "\\u0300-\\u036f\\ufe20-\\ufe23";
  var rsComboSymbolsRange = "\\u20d0-\\u20f0";
  var rsVarRange = "\\ufe0e\\ufe0f";
  var rsAstral = "[" + rsAstralRange + "]";
  var rsCombo = "[" + rsComboMarksRange + rsComboSymbolsRange + "]";
  var rsFitz = "\\ud83c[\\udffb-\\udfff]";
  var rsModifier = "(?:" + rsCombo + "|" + rsFitz + ")";
  var rsNonAstral = "[^" + rsAstralRange + "]";
  var rsRegional = "(?:\\ud83c[\\udde6-\\uddff]){2}";
  var rsSurrPair = "[\\ud800-\\udbff][\\udc00-\\udfff]";
  var rsZWJ = "\\u200d";
  var reOptMod = rsModifier + "?";
  var rsOptVar = "[" + rsVarRange + "]?";
  var rsOptJoin = "(?:" + rsZWJ + "(?:" + [rsNonAstral, rsRegional, rsSurrPair].join("|") + ")" + rsOptVar + reOptMod + ")*";
  var rsSeq = rsOptVar + reOptMod + rsOptJoin;
  var rsSymbol = "(?:" + [rsNonAstral + rsCombo + "?", rsCombo, rsRegional, rsSurrPair, rsAstral].join("|") + ")";
  var reUnicode = RegExp(rsFitz + "(?=" + rsFitz + ")|" + rsSymbol + rsSeq, "g");
  var reHasUnicode = RegExp("[" + rsZWJ + rsAstralRange + rsComboMarksRange + rsComboSymbolsRange + rsVarRange + "]");
  var freeParseInt = parseInt;
  var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
  var freeSelf = typeof self == "object" && self && self.Object === Object && self;
  var root = freeGlobal || freeSelf || Function("return this")();
  var asciiSize = baseProperty("length");
  function asciiToArray(string) {
    return string.split("");
  }
  function baseProperty(key) {
    return function(object) {
      return object == null ? undefined : object[key];
    };
  }
  function hasUnicode(string) {
    return reHasUnicode.test(string);
  }
  function stringSize(string) {
    return hasUnicode(string) ? unicodeSize(string) : asciiSize(string);
  }
  function stringToArray(string) {
    return hasUnicode(string) ? unicodeToArray(string) : asciiToArray(string);
  }
  function unicodeSize(string) {
    var result = reUnicode.lastIndex = 0;
    while (reUnicode.test(string)) {
      result++;
    }
    return result;
  }
  function unicodeToArray(string) {
    return string.match(reUnicode) || [];
  }
  var objectProto = Object.prototype;
  var objectToString2 = objectProto.toString;
  var Symbol2 = root.Symbol;
  var nativeCeil = Math.ceil;
  var nativeFloor = Math.floor;
  var symbolProto = Symbol2 ? Symbol2.prototype : undefined;
  var symbolToString = symbolProto ? symbolProto.toString : undefined;
  function baseRepeat(string, n) {
    var result = "";
    if (!string || n < 1 || n > MAX_SAFE_INTEGER) {
      return result;
    }
    do {
      if (n % 2) {
        result += string;
      }
      n = nativeFloor(n / 2);
      if (n) {
        string += string;
      }
    } while (n);
    return result;
  }
  function baseSlice(array, start, end) {
    var index = -1, length = array.length;
    if (start < 0) {
      start = -start > length ? 0 : length + start;
    }
    end = end > length ? length : end;
    if (end < 0) {
      end += length;
    }
    length = start > end ? 0 : end - start >>> 0;
    start >>>= 0;
    var result = Array(length);
    while (++index < length) {
      result[index] = array[index + start];
    }
    return result;
  }
  function baseToString(value) {
    if (typeof value == "string") {
      return value;
    }
    if (isSymbol2(value)) {
      return symbolToString ? symbolToString.call(value) : "";
    }
    var result = value + "";
    return result == "0" && 1 / value == -INFINITY ? "-0" : result;
  }
  function castSlice(array, start, end) {
    var length = array.length;
    end = end === undefined ? length : end;
    return !start && end >= length ? array : baseSlice(array, start, end);
  }
  function createPadding(length, chars) {
    chars = chars === undefined ? " " : baseToString(chars);
    var charsLength = chars.length;
    if (charsLength < 2) {
      return charsLength ? baseRepeat(chars, length) : chars;
    }
    var result = baseRepeat(chars, nativeCeil(length / stringSize(chars)));
    return hasUnicode(chars) ? castSlice(stringToArray(result), 0, length).join("") : result.slice(0, length);
  }
  function isObject2(value) {
    var type = typeof value;
    return !!value && (type == "object" || type == "function");
  }
  function isObjectLike(value) {
    return !!value && typeof value == "object";
  }
  function isSymbol2(value) {
    return typeof value == "symbol" || isObjectLike(value) && objectToString2.call(value) == symbolTag;
  }
  function toFinite(value) {
    if (!value) {
      return value === 0 ? value : 0;
    }
    value = toNumber(value);
    if (value === INFINITY || value === -INFINITY) {
      var sign = value < 0 ? -1 : 1;
      return sign * MAX_INTEGER;
    }
    return value === value ? value : 0;
  }
  function toInteger(value) {
    var result = toFinite(value), remainder = result % 1;
    return result === result ? remainder ? result - remainder : result : 0;
  }
  function toNumber(value) {
    if (typeof value == "number") {
      return value;
    }
    if (isSymbol2(value)) {
      return NAN;
    }
    if (isObject2(value)) {
      var other = typeof value.valueOf == "function" ? value.valueOf() : value;
      value = isObject2(other) ? other + "" : other;
    }
    if (typeof value != "string") {
      return value === 0 ? value : +value;
    }
    value = value.replace(reTrim, "");
    var isBinary = reIsBinary.test(value);
    return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
  }
  function toString(value) {
    return value == null ? "" : baseToString(value);
  }
  function padEnd(string, length, chars) {
    string = toString(string);
    length = toInteger(length);
    var strLength = length ? stringSize(string) : 0;
    return length && strLength < length ? string + createPadding(length - strLength, chars) : string;
  }
  module.exports = padEnd;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/normalize-coord.js
var require_normalize_coord = __commonJS((exports, module) => {
  var numIsFinite = require_lodash();
  var padLeft = require_lodash2();
  var padRight = require_lodash3();
  var normalizeCoord = function(number, format2) {
    if (number == null) {
      return NaN;
    }
    var numberString = "" + number;
    var sign = "+";
    if (numberString[0] === "-" || numberString[0] === "+") {
      sign = numberString[0];
      numberString = numberString.slice(1);
    }
    var hasDecimal = numberString.indexOf(".") !== -1;
    if (hasDecimal || format2 == null || format2.zero == null) {
      return Number(sign + numberString);
    } else {
      if (format2.places == null || format2.places.length !== 2) {
        return NaN;
      }
      var leading = format2.places[0];
      var trailing = format2.places[1];
      if (!numIsFinite(leading) || !numIsFinite(trailing)) {
        return NaN;
      }
      if (format2.zero === "T") {
        numberString = padRight(numberString, leading + trailing, "0");
      } else if (format2.zero === "L") {
        numberString = padLeft(numberString, leading + trailing, "0");
      } else {
        return NaN;
      }
    }
    var before = numberString.slice(0, leading);
    var after = numberString.slice(leading, leading + trailing);
    return Number(sign + before + "." + after);
  };
  module.exports = normalizeCoord;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/parse-coord.js
var require_parse_coord = __commonJS((exports, module) => {
  var normalize = require_normalize_coord();
  var RE_TRAILING = /[XY]0\d+/;
  var RE_LEADING = /[XY]\d+0(?=\D|$)/;
  var MATCH = [
    { coord: "x", test: /X([+-]?[\d.]+)/ },
    { coord: "y", test: /Y([+-]?[\d.]+)/ },
    { coord: "i", test: /I([+-]?[\d.]+)/ },
    { coord: "j", test: /J([+-]?[\d.]+)/ },
    { coord: "a", test: /A([\d.]+)/ }
  ];
  var parse = function(coord, format2) {
    if (coord == null) {
      return {};
    }
    if (format2.zero == null || format2.places == null) {
      throw new Error("cannot parse coordinate with format undefined");
    }
    var parsed = MATCH.reduce(function(result, matcher) {
      var coordMatch = coord.match(matcher.test);
      if (coordMatch) {
        result[matcher.coord] = normalize(coordMatch[1], format2);
      }
      return result;
    }, {});
    return parsed;
  };
  var detectZero = function(coord) {
    if (RE_LEADING.test(coord)) {
      return "L";
    }
    if (RE_TRAILING.test(coord)) {
      return "T";
    }
    return null;
  };
  module.exports = { parse, detectZero };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_parse-macro-expression.js
var require__parse_macro_expression = __commonJS((exports, module) => {
  var RE_OP = /[+\-/xX()]/;
  var RE_NUMBER = /[$\d.]+/;
  var RE_TOKEN = new RegExp([RE_OP.source, RE_NUMBER.source].join("|"), "g");
  module.exports = function parseMacroExpression(parser, expr) {
    var tokens = expr.match(RE_TOKEN);
    var parseExpression;
    var parsePrimary = function() {
      var t = tokens.shift();
      var exp;
      if (RE_NUMBER.test(t)) {
        exp = { type: "n", val: t };
      } else {
        exp = parseExpression();
        tokens.shift();
      }
      return exp;
    };
    var parseMultiplication = function() {
      var exp = parsePrimary();
      var t = tokens[0];
      if (t === "X") {
        parser._warn("multiplication in macros should use 'x', not 'X'");
        t = "x";
      }
      while (t === "x" || t === "/") {
        tokens.shift();
        var right = parsePrimary();
        exp = { type: t, left: exp, right };
        t = tokens[0];
      }
      return exp;
    };
    parseExpression = function() {
      var exp = parseMultiplication();
      var t = tokens[0];
      while (t === "+" || t === "-") {
        tokens.shift();
        var right = parseMultiplication();
        exp = { type: t, left: exp, right };
        t = tokens[0];
      }
      return exp;
    };
    var tree = parseExpression();
    var evaluate = function(op, mods) {
      var getValue = function(t) {
        if (t[0] === "$") {
          return Number(mods[t]);
        }
        return Number(t);
      };
      var type = op.type;
      if (type === "n") {
        return getValue(op.val);
      }
      if (type === "+") {
        return evaluate(op.left, mods) + evaluate(op.right, mods);
      }
      if (type === "-") {
        return evaluate(op.left, mods) - evaluate(op.right, mods);
      }
      if (type === "x") {
        return evaluate(op.left, mods) * evaluate(op.right, mods);
      }
      return evaluate(op.left, mods) / evaluate(op.right, mods);
    };
    return function(mods) {
      return evaluate(tree, mods);
    };
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_parse-macro-block.js
var require__parse_macro_block = __commonJS((exports, module) => {
  var parseMacroExpr = require__parse_macro_expression();
  var RE_NUM = /^-?[\d.]+$/;
  var RE_VAR_DEF = /^(\$[\d+])=(.+)/;
  var parseMacroBlock = function(parser, block) {
    if (block[0] === "0") {
      return { type: "comment" };
    }
    if (RE_VAR_DEF.test(block)) {
      var varDefMatch = block.match(RE_VAR_DEF);
      var varName = varDefMatch[1];
      var varExpr = varDefMatch[2];
      var evaluate = parseMacroExpr(parser, varExpr);
      var setMods = function(mods2) {
        mods2[varName] = evaluate(mods2);
        return mods2;
      };
      return { type: "variable", set: setMods };
    }
    var modVal = function(m) {
      if (RE_NUM.test(m)) {
        return Number(m);
      }
      return parseMacroExpr(parser, m);
    };
    var mods = block.split(",").map(modVal);
    var code2 = mods[0];
    var exp = mods[1];
    if (code2 === 1) {
      return {
        type: "circle",
        exp,
        dia: mods[2],
        cx: mods[3],
        cy: mods[4],
        rot: mods[5] || 0
      };
    }
    if (code2 === 2) {
      parser._warn("macro aperture vector primitives with code 2 are deprecated");
    }
    if (code2 === 2 || code2 === 20) {
      return {
        type: "vect",
        exp,
        width: mods[2],
        x1: mods[3],
        y1: mods[4],
        x2: mods[5],
        y2: mods[6],
        rot: mods[7]
      };
    }
    if (code2 === 21) {
      return {
        type: "rect",
        exp,
        width: mods[2],
        height: mods[3],
        cx: mods[4],
        cy: mods[5],
        rot: mods[6]
      };
    }
    if (code2 === 22) {
      parser._warn("macro aperture lower-left rectangle primitives are deprecated");
      return {
        type: "rectLL",
        exp,
        width: mods[2],
        height: mods[3],
        x: mods[4],
        y: mods[5],
        rot: mods[6]
      };
    }
    if (code2 === 4) {
      return {
        type: "outline",
        exp,
        points: mods.slice(3, -1),
        rot: mods[mods.length - 1]
      };
    }
    if (code2 === 5) {
      return {
        type: "poly",
        exp,
        vertices: mods[2],
        cx: mods[3],
        cy: mods[4],
        dia: mods[5],
        rot: mods[6]
      };
    }
    if (code2 === 6) {
      return {
        type: "moire",
        exp: 1,
        cx: mods[1],
        cy: mods[2],
        dia: mods[3],
        ringThx: mods[4],
        ringGap: mods[5],
        maxRings: mods[6],
        crossThx: mods[7],
        crossLen: mods[8],
        rot: mods[9]
      };
    }
    if (code2 === 7) {
      return {
        type: "thermal",
        exp: 1,
        cx: mods[1],
        cy: mods[2],
        outerDia: mods[3],
        innerDia: mods[4],
        gap: mods[5],
        rot: mods[6]
      };
    } else {
      parser._warn(code2 + " is an unrecognized primitive for a macro aperture");
    }
  };
  module.exports = parseMacroBlock;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_parse-gerber.js
var require__parse_gerber = __commonJS((exports, module) => {
  var commands = require__commands();
  var normalize = require_normalize_coord();
  var parseCoord = require_parse_coord();
  var parseMacroBlock = require__parse_macro_block();
  var RE_MODE = /^G0*([123])/;
  var RE_REGION = /^G3([67])/;
  var RE_ARC = /^G7([45])/;
  var RE_BKP_UNITS = /^G7([01])/;
  var RE_BKP_NOTA = /^G9([01])/;
  var RE_COMMENT = /^G0*4/;
  var RE_TO = /^%TO[^%*]*/;
  var RE_TOOL = /^(?:G54)?D0*([1-9]\d+)/;
  var RE_OP = /D0*([123])$/;
  var RE_COORD = /^(?:G0*[123])?((?:[XYIJ][+-]?\d+){1,4})(?:D0*[123])?$/;
  var RE_UNITS = /^%MO(IN|MM)/;
  var RE_FORMAT = /^%FS([LT]?)([AI]?)(.*)X([0-7])([0-7])Y\4\5/;
  var RE_POLARITY = /^%LP([CD])/;
  var RE_STEP_REP = /^%SR(?:X(\d+)Y(\d+)I([\d.]+)J([\d.]+))?/;
  var RE_TOOL_DEF = /^%ADD0*(\d{2,})([A-Za-z_$][\w\-.]*)(?:,((?:X?[\d.-]+)*))?/;
  var RE_MACRO = /^%AM([A-Za-z_$][\w\-.]*)\*?(.*)/;
  var RE_CADENCE_ALLEGRO_UNITS_IN_FORMAT = /\*MO(IN|MM)$/;
  var parseUnits = function(parser, unitsMatch) {
    var units = unitsMatch === "IN" ? "in" : "mm";
    return parser._push(commands.set("units", units));
  };
  var parseToolDef = function(parser, block) {
    var format2 = { places: parser.format.places };
    var toolMatch = block.match(RE_TOOL_DEF);
    var tool = toolMatch[1];
    var shapeMatch = toolMatch[2];
    var toolArgs = toolMatch[3] ? toolMatch[3].split("X") : [];
    var shape;
    var maxArgs;
    if (shapeMatch === "C") {
      shape = "circle";
      maxArgs = 3;
    } else if (shapeMatch === "R") {
      shape = "rect";
      maxArgs = 4;
    } else if (shapeMatch === "O") {
      shape = "obround";
      maxArgs = 4;
    } else if (shapeMatch === "P") {
      shape = "poly";
      maxArgs = 5;
    } else {
      shape = shapeMatch;
      maxArgs = 0;
    }
    var val;
    if (shape === "circle") {
      val = [normalize(toolArgs[0], format2)];
    } else if (shape === "rect" || shape === "obround") {
      val = [normalize(toolArgs[0], format2), normalize(toolArgs[1], format2)];
    } else if (shape === "poly") {
      val = [normalize(toolArgs[0], format2), Number(toolArgs[1]), 0];
      if (toolArgs[2]) {
        val[2] = Number(toolArgs[2]);
      }
    } else {
      val = toolArgs.map(Number);
    }
    var hole = [];
    if (toolArgs[maxArgs - 1]) {
      hole = [
        normalize(toolArgs[maxArgs - 2], format2),
        normalize(toolArgs[maxArgs - 1], format2)
      ];
    } else if (toolArgs[maxArgs - 2]) {
      hole = [normalize(toolArgs[maxArgs - 2], format2)];
    }
    var toolDef = { shape, params: val, hole };
    return parser._push(commands.tool(tool, toolDef));
  };
  var parseMacroDef = function(parser, block) {
    var macroMatch = block.match(RE_MACRO);
    var name = macroMatch[1];
    if (name.match(/-/)) {
      parser._warn("hyphens in macro name are illegal: " + name);
    }
    var blockMatch = macroMatch[2].length ? macroMatch[2].split("*") : [];
    var blocks = blockMatch.filter(Boolean).map(function(block2) {
      return parseMacroBlock(parser, block2);
    });
    return parser._push(commands.macro(name, blocks));
  };
  var parse = function(parser, block) {
    if (RE_COMMENT.test(block) || RE_TO.test(block)) {
      return;
    }
    if (block === "M02") {
      return parser._push(commands.done());
    }
    if (RE_REGION.test(block)) {
      var regionMatch = block.match(RE_REGION)[1];
      var region = regionMatch === "6";
      return parser._push(commands.set("region", region));
    }
    if (RE_ARC.test(block)) {
      var arcMatch = block.match(RE_ARC)[1];
      var arc = arcMatch === "4" ? "s" : "m";
      return parser._push(commands.set("arc", arc));
    }
    if (RE_UNITS.test(block)) {
      var unitsMatch = block.match(RE_UNITS)[1];
      return parseUnits(parser, unitsMatch);
    }
    if (RE_BKP_UNITS.test(block)) {
      var bkpUnitsMatch = block.match(RE_BKP_UNITS)[1];
      var backupUnits = bkpUnitsMatch === "0" ? "in" : "mm";
      return parser._push(commands.set("backupUnits", backupUnits));
    }
    if (RE_FORMAT.test(block)) {
      var formatMatch = block.match(RE_FORMAT);
      var zero = formatMatch[1];
      var nota = formatMatch[2];
      var unknown = formatMatch[3];
      var leading = Number(formatMatch[4]);
      var trailing = Number(formatMatch[5]);
      var format2 = parser.format;
      format2.zero = format2.zero || zero;
      if (!format2.places) {
        format2.places = [leading, trailing];
      }
      if (!format2.zero) {
        format2.zero = "L";
        parser._warn("zero suppression missing from format; assuming leading");
      } else if (format2.zero === "T") {
        parser._warn("trailing zero suppression has been deprecated");
      }
      if (unknown) {
        parser._warn('unknown characters "' + unknown + '" in "' + block + '" were ignored');
      }
      var epsilon = 1.5 * Math.pow(10, -format2.places[1]);
      parser._push(commands.set("nota", nota));
      parser._push(commands.set("epsilon", epsilon));
      if (RE_CADENCE_ALLEGRO_UNITS_IN_FORMAT.test(block)) {
        var caUnitsMatch = block.match(RE_CADENCE_ALLEGRO_UNITS_IN_FORMAT)[1];
        parseUnits(parser, caUnitsMatch);
      }
      return;
    }
    if (RE_BKP_NOTA.test(block)) {
      var bkpNotaMatch = block.match(RE_BKP_NOTA)[1];
      var backupNota = bkpNotaMatch === "0" ? "A" : "I";
      return parser._push(commands.set("backupNota", backupNota));
    }
    if (RE_POLARITY.test(block)) {
      var polarity = block.match(RE_POLARITY)[1];
      return parser._push(commands.level("polarity", polarity));
    }
    if (RE_STEP_REP.test(block)) {
      var stepRepeatMatch = block.match(RE_STEP_REP);
      var x = stepRepeatMatch[1] || 1;
      var y = stepRepeatMatch[2] || 1;
      var i2 = stepRepeatMatch[3] || 0;
      var j = stepRepeatMatch[4] || 0;
      var sr = { x: Number(x), y: Number(y), i: Number(i2), j: Number(j) };
      return parser._push(commands.level("stepRep", sr));
    }
    if (RE_TOOL.test(block)) {
      var tool = block.match(RE_TOOL)[1];
      return parser._push(commands.set("tool", tool));
    }
    if (RE_TOOL_DEF.test(block)) {
      return parseToolDef(parser, block);
    }
    if (RE_MACRO.test(block)) {
      return parseMacroDef(parser, block);
    }
    if (RE_OP.test(block) || RE_MODE.test(block) || RE_COORD.test(block)) {
      var opMatch = block.match(RE_OP);
      var modeMatch = block.match(RE_MODE);
      var coordMatch = block.match(RE_COORD);
      var mode;
      if (modeMatch) {
        if (modeMatch[1] === "1") {
          mode = "i";
        } else if (modeMatch[1] === "2") {
          mode = "cw";
        } else {
          mode = "ccw";
        }
        parser._push(commands.set("mode", mode));
      }
      if (opMatch || coordMatch) {
        var opCode = opMatch ? opMatch[1] : "";
        var coordString = coordMatch ? coordMatch[1] : "";
        var coord = parseCoord.parse(coordString, parser.format);
        var op = "last";
        if (opCode === "1") {
          op = "int";
        } else if (opCode === "2") {
          op = "move";
        } else if (opCode === "3") {
          op = "flash";
        }
        parser._push(commands.op(op, coord));
      }
      return;
    }
    return parser._warn('block "' + block + '" was not recognized and was ignored');
  };
  module.exports = parse;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_drill-mode.js
var require__drill_mode = __commonJS((exports, module) => {
  module.exports = {
    DRILL: "5",
    MOVE: "0",
    LINEAR: "1",
    CW_ARC: "2",
    CCW_ARC: "3"
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_parse-drill.js
var require__parse_drill = __commonJS((exports, module) => {
  var numIsFinite = require_lodash();
  var commands = require__commands();
  var drillMode = require__drill_mode();
  var normalize = require_normalize_coord();
  var parseCoord = require_parse_coord();
  var RE_ALTIUM_HINT = /;FILE_FORMAT=(\d):(\d)/;
  var RE_ALTIUM_PLATING_HINT = /;TYPE=(PLATED|NON_PLATED)/;
  var RE_KI_HINT = /;FORMAT={(.):(.)\/ (absolute|.+)? \/ (metric|inch) \/.+(trailing|leading|decimal|keep)/;
  var RE_UNITS = /^(INCH|METRIC|M71|M72)/;
  var RE_ZERO = /,([TL])Z/;
  var RE_FORMAT = /,(0{1,8})\.(0{1,8})/;
  var RE_TOOL_DEF = /T0*(\d+)[\S]*C([\d.]+)/;
  var RE_TOOL_SET = /T0*(\d+)(?![\S]*C)/;
  var RE_COORD = /((?:[XYIJA][+-]?[\d.]+){1,4})(?:G85((?:[XY][+-]?[\d.]+){1,2}))?/;
  var RE_ROUTE = /^G0([01235])/;
  var parseCommentForFormatHints = function(parser, block, line) {
    var result = {};
    if (RE_KI_HINT.test(block)) {
      var kicadMatch = block.match(RE_KI_HINT);
      var leading = Number(kicadMatch[1]);
      var trailing = Number(kicadMatch[2]);
      var absolute = kicadMatch[3];
      var unitSet = kicadMatch[4];
      var suppressionSet = kicadMatch[5];
      if (numIsFinite(leading) && numIsFinite(trailing)) {
        result.places = [leading, trailing];
      }
      if (absolute === "absolute") {
        parser._push(commands.set("backupNota", "A", line));
      } else {
        parser._push(commands.set("backupNota", "I", line));
      }
      if (unitSet === "metric") {
        parser._push(commands.set("backupUnits", "mm", line));
      } else {
        parser._push(commands.set("backupUnits", "in", line));
      }
      if (suppressionSet === "leading" || suppressionSet === "keep") {
        result.zero = "L";
      } else if (suppressionSet === "trailing") {
        result.zero = "T";
      } else {
        result.zero = "D";
      }
    } else if (RE_ALTIUM_HINT.test(block)) {
      var altiumMatch = block.match(RE_ALTIUM_HINT);
      result.places = [Number(altiumMatch[1]), Number(altiumMatch[2])];
    } else if (RE_ALTIUM_PLATING_HINT.test(block)) {
      var platingMatch = block.match(RE_ALTIUM_PLATING_HINT);
      var holePlating = platingMatch[1] === "PLATED" ? "pth" : "npth";
      parser._push(commands.set("holePlating", holePlating, line));
    }
    return result;
  };
  var parseUnits = function(parser, block, line) {
    var unitsMatch = block.match(RE_UNITS);
    var zeroMatch = block.match(RE_ZERO);
    var formatMatch = block.match(RE_FORMAT);
    var units = unitsMatch[1] === "METRIC" || unitsMatch[1] === "M71" ? "mm" : "in";
    var keep = zeroMatch && zeroMatch[1];
    if (parser.format.zero == null && keep) {
      parser.format.zero = keep === "T" ? "L" : "T";
    }
    if (parser.format.places == null) {
      if (formatMatch) {
        parser.format.places = [formatMatch[1].length, formatMatch[2].length];
      } else {
        parser.format.places = units === "in" ? [2, 4] : [3, 3];
      }
    }
    parser._push(commands.set("units", units, line));
  };
  var coordToCommand = function(parser, block, line) {
    var coordMatch = block.match(RE_COORD);
    var coord = parseCoord.parse(coordMatch[1], parser.format);
    if (coordMatch[2]) {
      parser._push(commands.op("move", coord, line));
      parser._push(commands.set("mode", "i", line));
      coord = parseCoord.parse(coordMatch[2], parser.format);
      return parser._push(commands.op("int", coord, line));
    }
    if (RE_ROUTE.test(block)) {
      parser._drillMode = block.match(RE_ROUTE)[1];
    }
    switch (parser._drillMode) {
      case drillMode.DRILL:
        return parser._push(commands.op("flash", coord, line));
      case drillMode.MOVE:
        return parser._push(commands.op("move", coord, line));
      case drillMode.LINEAR:
        parser._push(commands.set("mode", "i", line));
        return parser._push(commands.op("int", coord, line));
      case drillMode.CW_ARC:
        parser._push(commands.set("mode", "cw", line));
        return parser._push(commands.op("int", coord, line));
      case drillMode.CCW_ARC:
        parser._push(commands.set("mode", "ccw", line));
        return parser._push(commands.op("int", coord, line));
    }
  };
  var parseBlock = function(parser, block, line) {
    if (RE_TOOL_DEF.test(block)) {
      var toolMatch = block.match(RE_TOOL_DEF);
      var toolCode = toolMatch[1];
      var toolDia = normalize(toolMatch[2]);
      var toolDef = { shape: "circle", params: [toolDia], hole: [] };
      return parser._push(commands.tool(toolCode, toolDef, line));
    }
    if (RE_TOOL_SET.test(block)) {
      var toolSet = block.match(RE_TOOL_SET)[1];
      parser._push(commands.set("tool", toolSet, line));
    }
    if (RE_COORD.test(block)) {
      if (!parser.format.places) {
        parser.format.places = [2, 4];
        parser._warn("places format missing; assuming [2, 4]");
      }
      if (!parser.format.zero) {
        parser.format.zero = "T";
        parser._warn("zero suppression missing; assuming trailing suppression");
      }
      return coordToCommand(parser, block, line);
    }
    if (block === "M00" || block === "M30") {
      return parser._push(commands.done(line));
    }
    if (block === "G90") {
      return parser._push(commands.set("nota", "A", line));
    }
    if (block === "G91") {
      return parser._push(commands.set("nota", "I", line));
    }
    if (RE_UNITS.test(block)) {
      return parseUnits(parser, block, line);
    }
  };
  var flush = function(parser) {
    parser._drillStash.forEach(function(data) {
      parseBlock(parser, data.block, data.line);
    });
    parser._drillStash = [];
  };
  var parse = function(parser, block) {
    if (block[0] === ";") {
      var formatHints = parseCommentForFormatHints(parser, block, parser.line);
      Object.keys(formatHints).forEach(function(key) {
        if (!parser.format[key]) {
          parser.format[key] = formatHints[key];
        }
      });
    } else if (!parser.format.zero) {
      parser._drillStash.push({ line: parser.line, block });
      if (RE_COORD.test(block)) {
        parser.format.zero = parseCoord.detectZero(block);
        if (parser.format.zero) {
          parser._warn("zero suppression missing; detected " + (parser.format.zero === "L" ? "leading" : "trailing") + " suppression");
        }
      }
      if (parser.format.zero || RE_ZERO.test(block) || parser._drillStash.length >= 1000) {
        flush(parser);
      }
    } else {
      parseBlock(parser, block, parser.line);
    }
  };
  module.exports = { parse, flush };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/_warning.js
var require__warning = __commonJS((exports, module) => {
  var warning = function(message, line) {
    return { message, line };
  };
  module.exports = warning;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/lib/parser.js
var require_parser = __commonJS((exports, module) => {
  var StringDecoder2 = (init_string_decoder(), __toCommonJS(exports_string_decoder)).StringDecoder;
  var inherits2 = require_inherits_browser();
  var Transform = require_readable_browser().Transform;
  var determineFiletype = require__determine_filetype();
  var getNext = require_get_next_block();
  var parseGerber = require__parse_gerber();
  var parseDrill = require__parse_drill();
  var warning = require__warning();
  var drillMode = require__drill_mode();
  var LIMIT = 65535;
  var Parser = function(places, zero, filetype) {
    Transform.call(this, { readableObjectMode: true });
    this._decoder = new StringDecoder2("utf8");
    this._stash = "";
    this._index = 0;
    this._drillMode = drillMode.DRILL;
    this._drillStash = [];
    this._syncResult = null;
    this.line = 0;
    this.format = { places, zero, filetype };
  };
  inherits2(Parser, Transform);
  Parser.prototype._process = function(chunk, filetype) {
    while (this._index < chunk.length) {
      var next = getNext(filetype, chunk, this._index);
      this._index += next.read;
      this.line += next.lines;
      this._stash += next.rem;
      if (next.block) {
        if (filetype === "gerber") {
          parseGerber(this, next.block);
        } else {
          parseDrill.parse(this, next.block);
        }
      }
    }
  };
  Parser.prototype._transform = function(chunk, encoding, done) {
    var filetype = this.format.filetype;
    chunk = this._decoder.write(chunk);
    if (!filetype) {
      filetype = determineFiletype(chunk, this._index, LIMIT);
      this._index += chunk.length;
      if (!filetype) {
        if (this._index >= LIMIT) {
          return done(new Error("unable to determine filetype"));
        }
        this._stash += chunk;
        return done();
      } else {
        this.format.filetype = filetype;
        this._index = 0;
      }
    }
    chunk = this._stash + chunk;
    this._stash = "";
    this._process(chunk, filetype);
    this._index = 0;
    done();
  };
  Parser.prototype._flush = function(done) {
    if (this.format.filetype === "drill") {
      parseDrill.flush(this);
    }
    return done && done();
  };
  Parser.prototype._push = function(data) {
    if (data.line === -1) {
      data.line = this.line;
    }
    var pushTarget = !this._syncResult ? this : this._syncResult;
    pushTarget.push(data);
  };
  Parser.prototype._warn = function(message) {
    this.emit("warning", warning(message, this.line));
  };
  Parser.prototype.parseSync = function(file) {
    var filetype = determineFiletype(file, this._index, 100 * LIMIT);
    this.format.filetype = filetype;
    this._syncResult = [];
    this._process(file, filetype);
    this._flush();
    return this._syncResult;
  };
  module.exports = Parser;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-parser/index.js
var require_gerber_parser = __commonJS((exports, module) => {
  var isFinite2 = require_lodash();
  var Parser = require_parser();
  var verifyPlaces = function(p) {
    if (Array.isArray(p) && p.length === 2 && isFinite2(p[0]) && isFinite2(p[1])) {
      return p;
    }
    throw new Error("places must be an array of two whole numbers");
  };
  var verifyZero = function(z) {
    if (z === "T" || z === "L") {
      return z;
    }
    throw new Error("zero suppression must be 'L' or 'T'");
  };
  var verifyFiletype = function(f) {
    if (f === "gerber" || f === "drill") {
      return f;
    }
    throw new Error('filetype must be "drill" or "gerber"');
  };
  module.exports = function(options) {
    options = options || {};
    var places = options.places ? verifyPlaces(options.places) : null;
    var zero = options.zero ? verifyZero(options.zero) : null;
    var filetype = options.filetype ? verifyFiletype(options.filetype) : null;
    return new Parser(places, zero, filetype);
  };
});

// ../../../../Development/anvil/anvild/node_modules/lodash.fill/index.js
var require_lodash4 = __commonJS((exports, module) => {
  var INFINITY = 1 / 0;
  var MAX_SAFE_INTEGER = 9007199254740991;
  var MAX_INTEGER = 179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;
  var NAN = 0 / 0;
  var MAX_ARRAY_LENGTH = 4294967295;
  var funcTag = "[object Function]";
  var genTag = "[object GeneratorFunction]";
  var symbolTag = "[object Symbol]";
  var reTrim = /^\s+|\s+$/g;
  var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
  var reIsBinary = /^0b[01]+$/i;
  var reIsOctal = /^0o[0-7]+$/i;
  var reIsUint = /^(?:0|[1-9]\d*)$/;
  var freeParseInt = parseInt;
  var objectProto = Object.prototype;
  var objectToString2 = objectProto.toString;
  function baseClamp(number, lower, upper) {
    if (number === number) {
      if (upper !== undefined) {
        number = number <= upper ? number : upper;
      }
      if (lower !== undefined) {
        number = number >= lower ? number : lower;
      }
    }
    return number;
  }
  function baseFill(array, value, start, end) {
    var length = array.length;
    start = toInteger(start);
    if (start < 0) {
      start = -start > length ? 0 : length + start;
    }
    end = end === undefined || end > length ? length : toInteger(end);
    if (end < 0) {
      end += length;
    }
    end = start > end ? 0 : toLength(end);
    while (start < end) {
      array[start++] = value;
    }
    return array;
  }
  function isIndex(value, length) {
    length = length == null ? MAX_SAFE_INTEGER : length;
    return !!length && (typeof value == "number" || reIsUint.test(value)) && (value > -1 && value % 1 == 0 && value < length);
  }
  function isIterateeCall(value, index, object) {
    if (!isObject2(object)) {
      return false;
    }
    var type = typeof index;
    if (type == "number" ? isArrayLike(object) && isIndex(index, object.length) : type == "string" && (index in object)) {
      return eq(object[index], value);
    }
    return false;
  }
  function fill(array, value, start, end) {
    var length = array ? array.length : 0;
    if (!length) {
      return [];
    }
    if (start && typeof start != "number" && isIterateeCall(array, value, start)) {
      start = 0;
      end = length;
    }
    return baseFill(array, value, start, end);
  }
  function eq(value, other) {
    return value === other || value !== value && other !== other;
  }
  function isArrayLike(value) {
    return value != null && isLength(value.length) && !isFunction2(value);
  }
  function isFunction2(value) {
    var tag = isObject2(value) ? objectToString2.call(value) : "";
    return tag == funcTag || tag == genTag;
  }
  function isLength(value) {
    return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
  }
  function isObject2(value) {
    var type = typeof value;
    return !!value && (type == "object" || type == "function");
  }
  function isObjectLike(value) {
    return !!value && typeof value == "object";
  }
  function isSymbol2(value) {
    return typeof value == "symbol" || isObjectLike(value) && objectToString2.call(value) == symbolTag;
  }
  function toFinite(value) {
    if (!value) {
      return value === 0 ? value : 0;
    }
    value = toNumber(value);
    if (value === INFINITY || value === -INFINITY) {
      var sign = value < 0 ? -1 : 1;
      return sign * MAX_INTEGER;
    }
    return value === value ? value : 0;
  }
  function toInteger(value) {
    var result = toFinite(value), remainder = result % 1;
    return result === result ? remainder ? result - remainder : result : 0;
  }
  function toLength(value) {
    return value ? baseClamp(toInteger(value), 0, MAX_ARRAY_LENGTH) : 0;
  }
  function toNumber(value) {
    if (typeof value == "number") {
      return value;
    }
    if (isSymbol2(value)) {
      return NAN;
    }
    if (isObject2(value)) {
      var other = typeof value.valueOf == "function" ? value.valueOf() : value;
      value = isObject2(other) ? other + "" : other;
    }
    if (typeof value != "string") {
      return value === 0 ? value : +value;
    }
    value = value.replace(reTrim, "");
    var isBinary = reIsBinary.test(value);
    return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
  }
  module.exports = fill;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/path-graph.js
var require_path_graph = __commonJS((exports, module) => {
  var fill = require_lodash4();
  var find = function(collection, condition) {
    var element;
    var i2;
    for (i2 = 0;i2 < collection.length; i2++) {
      element = collection[i2];
      if (condition(element)) {
        return element;
      }
    }
  };
  var findClosest = function(points, position, fillGaps) {
    var result = points.reduce(function(prev, point) {
      var d = distance(position, point.position);
      if (d < fillGaps && d < prev.distance) {
        return { point, distance: d };
      }
      return prev;
    }, { point: undefined, distance: Infinity });
    return result.point;
  };
  var distance = function(point, target) {
    return Math.sqrt(Math.pow(point[0] - target[0], 2) + Math.pow(point[1] - target[1], 2));
  };
  var pointsEqual = function(point, target) {
    return point[0] === target[0] && point[1] === target[1];
  };
  var lineSegmentsEqual = function(segment, target) {
    return segment.type === "line" && (pointsEqual(segment.start, target.start) && pointsEqual(segment.end, target.end) || pointsEqual(segment.start, target.end) && pointsEqual(segment.end, target.start));
  };
  var reverseSegment = function(segment) {
    var reversed = { type: segment.type, start: segment.end, end: segment.start };
    if (segment.type === "arc") {
      reversed.center = segment.center;
      reversed.radius = segment.radius;
      reversed.sweep = segment.sweep;
      reversed.dir = segment.dir === "cw" ? "ccw" : "cw";
    }
    return reversed;
  };
  var PathGraph = function(optimize, fillGaps) {
    this._edges = [];
    this._optimize = optimize;
    this._fillGaps = fillGaps;
    this.length = 0;
  };
  PathGraph.prototype.add = function(newSeg) {
    var edge = { segment: newSeg, start: newSeg.start, end: newSeg.end };
    this._edges.push(edge);
    this.length++;
  };
  PathGraph.prototype._fillGapsAndOptimize = function() {
    var newSegs = this._edges.map(function(x) {
      return x.segment;
    });
    this._edges = [];
    this.length = 0;
    var points = newSegs.reduce(function(prev, seg) {
      return prev.concat([
        { position: seg.start, edges: [] },
        { position: seg.end, edges: [] }
      ]);
    }, []);
    var len2 = newSegs.length;
    for (var i2 = 0;i2 < len2; i2++) {
      var newSeg = newSegs[i2];
      var start;
      var end;
      var fillGaps = this._fillGaps;
      var startIndex = i2 * 2;
      var endIndex = startIndex + 1;
      var otherPoints = points.slice(0, startIndex).concat(points.slice(endIndex + 1));
      start = findClosest(otherPoints, newSeg.start, fillGaps);
      end = findClosest(otherPoints, newSeg.end, fillGaps);
      if (!start) {
        start = { position: newSeg.start, edges: [] };
      } else if (fillGaps) {
        newSeg.start = start.position;
      }
      if (!end) {
        end = { position: newSeg.end, edges: [] };
      } else if (fillGaps) {
        newSeg.end = end.position;
      }
      var existing = find(this._edges, function(edge2) {
        return lineSegmentsEqual(edge2.segment, newSeg);
      });
      if (!existing) {
        var newEdgeIndex = this._edges.length;
        var edge = { segment: newSeg, start, end };
        points[startIndex].edges.push(newEdgeIndex);
        points[startIndex].position = edge.start.position;
        points[endIndex].edges.push(newEdgeIndex);
        points[endIndex].position = edge.end.position;
        this._edges.push(edge);
        this.length++;
      }
    }
    this._edges.forEach(function(edge2) {
      points.forEach(function(point) {
        if (pointsEqual(point.position, edge2.start.position)) {
          edge2.start.edges = edge2.start.edges.concat(point.edges);
        }
        if (pointsEqual(point.position, edge2.end.position)) {
          edge2.end.edges = edge2.end.edges.concat(point.edges);
        }
      });
    });
  };
  PathGraph.prototype.traverse = function() {
    if (!this._optimize) {
      return this._edges.map(function(edge) {
        return edge.segment;
      });
    }
    this._fillGapsAndOptimize();
    var walked = fill(Array(this._edges.length), false);
    var discovered = [];
    var result = [];
    var current;
    var currentEdge;
    var currentEnd;
    var currentSegment;
    var lastEnd = { position: [] };
    while (result.length < this._edges.length) {
      current = walked.indexOf(false);
      discovered.push(current);
      while (discovered.length) {
        current = discovered.pop();
        if (!walked[current]) {
          walked[current] = true;
          currentEdge = this._edges[current];
          currentEnd = currentEdge.end;
          if (pointsEqual(lastEnd.position, currentEnd.position)) {
            currentSegment = reverseSegment(currentEdge.segment);
            lastEnd = currentEdge.start;
          } else {
            currentSegment = currentEdge.segment;
            lastEnd = currentEdge.end;
          }
          lastEnd.edges.reverse().forEach(function(seg) {
            if (!walked[seg]) {
              discovered.push(seg);
            }
          });
          result.push(currentSegment);
        }
      }
    }
    return result;
  };
  module.exports = PathGraph;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/_warning.js
var require__warning2 = __commonJS((exports, module) => {
  var warning = function(message, line) {
    return { message, line };
  };
  module.exports = warning;
});

// ../../../../Development/anvil/anvild/node_modules/lodash.isfunction/index.js
var require_lodash5 = __commonJS((exports, module) => {
  var asyncTag = "[object AsyncFunction]";
  var funcTag = "[object Function]";
  var genTag = "[object GeneratorFunction]";
  var nullTag = "[object Null]";
  var proxyTag = "[object Proxy]";
  var undefinedTag = "[object Undefined]";
  var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
  var freeSelf = typeof self == "object" && self && self.Object === Object && self;
  var root = freeGlobal || freeSelf || Function("return this")();
  var objectProto = Object.prototype;
  var hasOwnProperty2 = objectProto.hasOwnProperty;
  var nativeObjectToString = objectProto.toString;
  var Symbol2 = root.Symbol;
  var symToStringTag = Symbol2 ? Symbol2.toStringTag : undefined;
  function baseGetTag(value) {
    if (value == null) {
      return value === undefined ? undefinedTag : nullTag;
    }
    return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString2(value);
  }
  function getRawTag(value) {
    var isOwn = hasOwnProperty2.call(value, symToStringTag), tag = value[symToStringTag];
    try {
      value[symToStringTag] = undefined;
      var unmasked = true;
    } catch (e) {}
    var result = nativeObjectToString.call(value);
    if (unmasked) {
      if (isOwn) {
        value[symToStringTag] = tag;
      } else {
        delete value[symToStringTag];
      }
    }
    return result;
  }
  function objectToString2(value) {
    return nativeObjectToString.call(value);
  }
  function isFunction2(value) {
    if (!isObject2(value)) {
      return false;
    }
    var tag = baseGetTag(value);
    return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
  }
  function isObject2(value) {
    var type = typeof value;
    return value != null && (type == "object" || type == "function");
  }
  module.exports = isFunction2;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/_box.js
var require__box = __commonJS((exports, module) => {
  var newBox = function() {
    return [Infinity, Infinity, -Infinity, -Infinity];
  };
  var add = function(box, target) {
    return [
      Math.min(box[0], target[0]),
      Math.min(box[1], target[1]),
      Math.max(box[2], target[2]),
      Math.max(box[3], target[3])
    ];
  };
  var addPoint = function(box, point) {
    return [
      Math.min(box[0], point[0]),
      Math.min(box[1], point[1]),
      Math.max(box[2], point[0]),
      Math.max(box[3], point[1])
    ];
  };
  var addCircle = function(box, r, cx, cy) {
    return [
      Math.min(box[0], cx - r),
      Math.min(box[1], cy - r),
      Math.max(box[2], cx + r),
      Math.max(box[3], cy + r)
    ];
  };
  var translate = function(box, delta) {
    var dx = delta[0];
    var dy = delta[1];
    return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
  };
  var repeat = function(box, repeat2) {
    return add(box, translate(box, repeat2));
  };
  module.exports = {
    new: newBox,
    add,
    addPoint,
    addCircle,
    translate,
    repeat
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/_pad-shape.js
var require__pad_shape = __commonJS((exports, module) => {
  var isFunction2 = require_lodash5();
  var isFinite2 = require_lodash();
  var boundingBox = require__box();
  var roundToPrecision = function(number) {
    var rounded = Math.round(number * 1e8) / 1e8;
    if (rounded === 0) {
      return 0;
    }
    return rounded;
  };
  var degreesToRadians = function(degrees) {
    return degrees * Math.PI / 180;
  };
  var rotatePointAboutOrigin = function(point, rot) {
    rot = degreesToRadians(rot);
    var sin = Math.sin(rot);
    var cos = Math.cos(rot);
    var x = point[0];
    var y = point[1];
    return [
      roundToPrecision(x * cos - y * sin),
      roundToPrecision(x * sin + y * cos)
    ];
  };
  var circle = function(dia, cx, cy, rot) {
    var r = dia / 2;
    cx = cx || 0;
    cy = cy || 0;
    if (rot && (cx || cy)) {
      var rotatedCenter = rotatePointAboutOrigin([cx, cy], rot);
      cx = rotatedCenter[0];
      cy = rotatedCenter[1];
    }
    return {
      shape: { type: "circle", cx, cy, r: dia / 2 },
      box: boundingBox.addCircle(boundingBox.new(), r, cx, cy)
    };
  };
  var vect = function(x1, y1, x2, y2, width, rot) {
    if (rot) {
      var start = rotatePointAboutOrigin([x1, y1], rot);
      var end = rotatePointAboutOrigin([x2, y2], rot);
      x1 = start[0];
      y1 = start[1];
      x2 = end[0];
      y2 = end[1];
    }
    var m = (y2 - y1) / (x2 - x1);
    var hWidth = width / 2;
    var sin = hWidth;
    var cos = hWidth;
    if (isFinite2(m)) {
      sin *= m / Math.sqrt(1 + Math.pow(m, 2));
      cos *= 1 / Math.sqrt(1 + Math.pow(m, 2));
    } else {
      cos = 0;
    }
    var points = [];
    points.push([roundToPrecision(x1 + sin), roundToPrecision(y1 - cos)]);
    points.push([roundToPrecision(x2 + sin), roundToPrecision(y2 - cos)]);
    points.push([roundToPrecision(x2 - sin), roundToPrecision(y2 + cos)]);
    points.push([roundToPrecision(x1 - sin), roundToPrecision(y1 + cos)]);
    var box = points.reduce(function(result, p) {
      return boundingBox.addPoint(result, p);
    }, boundingBox.new());
    return {
      shape: { type: "poly", points },
      box
    };
  };
  var rect = function(width, height, r, cx, cy, rot) {
    cx = cx || 0;
    cy = cy || 0;
    r = r || 0;
    rot = rot || 0;
    var hWidth = width / 2;
    var hHeight = height / 2;
    if (rot) {
      var x1 = cx - hWidth;
      var x2 = cx + hWidth;
      var y1 = cy;
      var y2 = cy;
      return vect(x1, y1, x2, y2, height, rot);
    }
    return {
      shape: { type: "rect", cx, cy, r, width, height },
      box: [-hWidth + cx, -hHeight + cy, hWidth + cx, hHeight + cy]
    };
  };
  var outlinePolygon = function(flatPoints, rot) {
    var points = [];
    var box = boundingBox.new();
    var point;
    for (var i2 = 0;i2 < flatPoints.length - 2; i2 += 2) {
      point = [flatPoints[i2], flatPoints[i2 + 1]];
      if (rot) {
        point = rotatePointAboutOrigin(point, rot);
      }
      points.push(point);
      box = boundingBox.addPoint(box, point);
    }
    return {
      shape: { type: "poly", points },
      box
    };
  };
  var regularPolygon = function(dia, nPoints, rot, cx, cy) {
    cx = cx || 0;
    cy = cy || 0;
    var points = [];
    var box = boundingBox.new();
    var r = dia / 2;
    var offset = rot * Math.PI / 180;
    var step = 2 * Math.PI / nPoints;
    var theta;
    var x;
    var y;
    for (var n = 0;n < nPoints; n++) {
      theta = step * n + offset;
      x = cx + roundToPrecision(r * Math.cos(theta));
      y = cy + roundToPrecision(r * Math.sin(theta));
      box = boundingBox.addPoint(box, [x, y]);
      points.push([x, y]);
    }
    return {
      shape: { type: "poly", points },
      box
    };
  };
  var ring = function(cx, cy, r, width) {
    return { type: "ring", cx, cy, r, width };
  };
  var moire = function(dia, ringThx, ringGap, maxRings, crossThx, crossLen, cx, cy, rot) {
    var r = dia / 2;
    var shape = [];
    var box = boundingBox.addCircle(boundingBox.new(), r, cx, cy);
    var halfThx = ringThx / 2;
    var gapAndHalfThx = ringGap + halfThx;
    while (r > ringThx && shape.length < maxRings) {
      r -= halfThx;
      shape.push(ring(cx, cy, roundToPrecision(r), ringThx));
      r -= gapAndHalfThx;
    }
    if (r > 0 && shape.length < maxRings) {
      shape.push(circle(roundToPrecision(2 * r), cx, cy).shape);
    }
    var horCross = rect(crossLen, crossThx, 0, cx, cy, rot);
    var verCross = rect(crossThx, crossLen, 0, cx, cy, rot);
    shape.push(horCross.shape);
    shape.push(verCross.shape);
    box = boundingBox.add(box, horCross.box);
    box = boundingBox.add(box, verCross.box);
    return { shape, box };
  };
  var thermal = function(cx, cy, outerDia, innerDia, gap, rot) {
    var side = roundToPrecision((outerDia - gap) / 2);
    var offset = roundToPrecision((outerDia + gap) / 4);
    var width = roundToPrecision((outerDia - innerDia) / 2);
    var r = roundToPrecision((outerDia - width) / 2);
    var box = boundingBox.addCircle(boundingBox.new(), outerDia / 2, cx, cy);
    var rects = [
      rect(side, side, 0, cx + offset, cy + offset, rot).shape,
      rect(side, side, 0, cx - offset, cy + offset, rot).shape,
      rect(side, side, 0, cx - offset, cy - offset, rot).shape,
      rect(side, side, 0, cx + offset, cy - offset, rot).shape
    ];
    var clip = ring(cx, cy, r, width);
    return {
      shape: { type: "clip", shape: rects, clip },
      box
    };
  };
  var runMacro = function(mods, blocks) {
    var emptyMacro = { shape: [], box: boundingBox.new() };
    var exposure = 1;
    blocks = blocks || [];
    return blocks.reduce(function(result, block) {
      var shapeAndBox;
      if (block.type !== "variable" && block.type !== "comment") {
        block = Object.keys(block).reduce(function(result2, key) {
          var value = block[key];
          result2[key] = resolveValue(value);
          return result2;
          function resolveValue(v) {
            if (Array.isArray(v)) {
              return v.map(resolveValue);
            } else if (isFunction2(v)) {
              return v(mods);
            } else {
              return v;
            }
          }
        }, {});
      }
      if (block.exp != null && block.exp !== exposure) {
        result.shape.push({
          type: "layer",
          polarity: block.exp === 1 ? "dark" : "clear",
          box: result.box.slice(0)
        });
        exposure = block.exp;
      }
      switch (block.type) {
        case "circle":
          shapeAndBox = circle(block.dia, block.cx, block.cy, block.rot);
          break;
        case "vect":
          shapeAndBox = vect(block.x1, block.y1, block.x2, block.y2, block.width, block.rot);
          break;
        case "rect":
          shapeAndBox = rect(block.width, block.height, 0, block.cx, block.cy, block.rot);
          break;
        case "rectLL":
          var hHeight = block.height / 2;
          var hWidth = block.width / 2;
          var cx = block.x + hWidth;
          var cy = block.y + hHeight;
          shapeAndBox = rect(block.width, block.height, 0, cx, cy, block.rot);
          break;
        case "outline":
          shapeAndBox = outlinePolygon(block.points, block.rot);
          break;
        case "poly":
          shapeAndBox = regularPolygon(block.dia, block.vertices, block.rot, block.cx, block.cy);
          break;
        case "moire":
          shapeAndBox = moire(block.dia, block.ringThx, block.ringGap, block.maxRings, block.crossThx, block.crossLen, block.cx, block.cy, block.rot);
          break;
        case "thermal":
          shapeAndBox = thermal(block.cx, block.cy, block.outerDia, block.innerDia, block.gap, block.rot);
          break;
        case "variable":
          mods = block.set(mods);
          return result;
        default:
          return result;
      }
      result.shape = result.shape.concat(shapeAndBox.shape);
      if (exposure === 1) {
        result.box = boundingBox.add(result.box, shapeAndBox.box);
      }
      return result;
    }, emptyMacro);
  };
  module.exports = function padShape(tool, macros) {
    var shape = [];
    var box = boundingBox.new();
    var toolShape = tool.shape;
    var params = tool.params;
    var holeShape;
    var shapeAndBox;
    if (toolShape === "circle") {
      shapeAndBox = circle(params[0]);
    } else if (toolShape === "rect") {
      shapeAndBox = rect(params[0], params[1]);
    } else if (toolShape === "obround") {
      shapeAndBox = rect(params[0], params[1], Math.min(params[0], params[1]) / 2);
    } else if (toolShape === "poly") {
      shapeAndBox = regularPolygon(params[0], params[1], params[2]);
    } else {
      var mods = params.reduce(function(result, val, index) {
        result["$" + (index + 1)] = val;
        return result;
      }, {});
      return runMacro(mods, macros[toolShape]);
    }
    shape.push(shapeAndBox.shape);
    box = boundingBox.add(box, shapeAndBox.box);
    if (tool.hole.length) {
      holeShape = tool.hole.length === 1 ? circle(tool.hole[0]).shape : rect(tool.hole[0], tool.hole[1]).shape;
      shape.push({ type: "layer", polarity: "clear", box }, holeShape);
    }
    return { shape, box };
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/_operate.js
var require__operate = __commonJS((exports, module) => {
  var boundingBox = require__box();
  var HALF_PI = Math.PI / 2;
  var PI = Math.PI;
  var TWO_PI = Math.PI * 2;
  var THREE_HALF_PI = 3 * Math.PI / 2;
  var flash = function(coord, tool, region, plotter) {
    if (region) {
      plotter._warn("flash in region ignored");
      return boundingBox.new();
    }
    if (!tool) {
      plotter._warn("flash with unknown tool ignored");
      return boundingBox.new();
    }
    if (!tool.flashed) {
      tool.flashed = true;
      plotter.push({ type: "shape", tool: tool.code, shape: tool.pad });
    }
    plotter.push({ type: "pad", tool: tool.code, x: coord[0], y: coord[1] });
    return boundingBox.translate(tool.box, coord);
  };
  var findCenterAndAngles = function(start, end, mode, arc, centers) {
    var thetaStart;
    var thetaEnd;
    var sweep;
    var candidate;
    var center;
    while (center == null && centers.length > 0) {
      candidate = centers.pop();
      thetaStart = Math.atan2(start[1] - candidate[1], start[0] - candidate[0]);
      thetaEnd = Math.atan2(end[1] - candidate[1], end[0] - candidate[0]);
      if (mode === "cw") {
        thetaStart = thetaStart >= thetaEnd ? thetaStart : thetaStart + TWO_PI;
      } else {
        thetaEnd = thetaEnd >= thetaStart ? thetaEnd : thetaEnd + TWO_PI;
      }
      sweep = Math.abs(thetaStart - thetaEnd);
      if (arc === "s") {
        if (sweep <= HALF_PI) {
          center = candidate;
        }
      } else {
        center = candidate;
      }
    }
    if (center == null) {
      return;
    }
    thetaStart = thetaStart >= 0 ? thetaStart : thetaStart + TWO_PI;
    thetaStart = thetaStart < TWO_PI ? thetaStart : thetaStart - TWO_PI;
    thetaEnd = thetaEnd >= 0 ? thetaEnd : thetaEnd + TWO_PI;
    thetaEnd = thetaEnd < TWO_PI ? thetaEnd : thetaEnd - TWO_PI;
    return {
      center,
      sweep,
      start: start.concat(thetaStart),
      end: end.concat(thetaEnd)
    };
  };
  var arcBox = function(cenAndAngles, r, region, tool, dir) {
    var startPoint = cenAndAngles.start;
    var endPoint = cenAndAngles.end;
    var center = cenAndAngles.center;
    var sweep = cenAndAngles.sweep;
    var start;
    var end;
    if (dir === "cw") {
      start = endPoint[2];
      end = startPoint[2];
    } else {
      start = startPoint[2];
      end = endPoint[2];
    }
    var points = [startPoint, endPoint];
    if (start > end || sweep === TWO_PI) {
      points.push([center[0] + r, center[1]]);
    }
    start = start >= HALF_PI ? start - HALF_PI : start + THREE_HALF_PI;
    end = end >= HALF_PI ? end - HALF_PI : end + THREE_HALF_PI;
    if (start > end || sweep === TWO_PI) {
      points.push([center[0], center[1] + r]);
    }
    start = start >= HALF_PI ? start - HALF_PI : start + THREE_HALF_PI;
    end = end >= HALF_PI ? end - HALF_PI : end + THREE_HALF_PI;
    if (start > end || sweep === TWO_PI) {
      points.push([center[0] - r, center[1]]);
    }
    start = start >= HALF_PI ? start - HALF_PI : start + THREE_HALF_PI;
    end = end >= HALF_PI ? end - HALF_PI : end + THREE_HALF_PI;
    if (start > end || sweep === TWO_PI) {
      points.push([center[0], center[1] - r]);
    }
    return points.reduce(function(result, m) {
      if (!region) {
        var mBox = boundingBox.translate(tool.box, m);
        return boundingBox.add(result, mBox);
      }
      return boundingBox.addPoint(result, m);
    }, boundingBox.new());
  };
  var roundToZero = function(number, epsilon) {
    return number >= epsilon ? number : 0;
  };
  var arcCenterFromRadius = function(start, end, mode, epsilon, radius) {
    var sign = mode === "ccw" ? 1 : -1;
    var xAve = (start[0] + end[0]) / 2;
    var yAve = (start[1] + end[1]) / 2;
    var deltaX = end[0] - start[1];
    var deltaY = end[1] - start[1];
    var distance = Math.sqrt(Math.pow(deltaX, 2) + Math.pow(deltaY, 2));
    var halfDistance = distance / 2;
    var squareDifference = Math.sqrt(Math.pow(radius, 2) - Math.pow(halfDistance, 2));
    var xOffset = -sign * deltaY * squareDifference / distance;
    var yOffset = sign * deltaX * squareDifference / distance;
    return [
      [
        roundToZero(xAve + xOffset, epsilon),
        roundToZero(yAve + yOffset, epsilon)
      ]
    ];
  };
  var drawArc = function(start, end, offset, tool, mode, arc, region, epsilon, pathGraph, plotter) {
    var r = offset[2] || Math.sqrt(Math.pow(offset[0], 2) + Math.pow(offset[1], 2));
    var candidates = [];
    var xCandidates = [];
    var yCandidates = [];
    if (offset[0] && arc === "s") {
      xCandidates.push(start[0] + offset[0], start[0] - offset[0]);
    } else {
      xCandidates.push(start[0] + offset[0]);
    }
    if (offset[1] && arc === "s") {
      yCandidates.push(start[1] + offset[1], start[1] - offset[1]);
    } else {
      yCandidates.push(start[1] + offset[1]);
    }
    for (var i2 = 0;i2 < xCandidates.length; i2++) {
      for (var j = 0;j < yCandidates.length; j++) {
        candidates.push([xCandidates[i2], yCandidates[j]]);
      }
    }
    var validCenters;
    if (offset[2]) {
      arc = "m";
      validCenters = arcCenterFromRadius(start, end, mode, epsilon, offset[2]);
    } else if (arc === "s") {
      validCenters = candidates.filter(function(c) {
        var startDist = Math.sqrt(Math.pow(c[0] - start[0], 2) + Math.pow(c[1] - start[1], 2));
        var endDist = Math.sqrt(Math.pow(c[0] - end[0], 2) + Math.pow(c[1] - end[1], 2));
        return Math.abs(startDist - r) <= epsilon && Math.abs(endDist - r) <= epsilon;
      });
    } else {
      validCenters = candidates;
    }
    var cenAndAngles = findCenterAndAngles(start, end, mode, arc, validCenters);
    if (arc === "m" && start[0] === end[0] && start[1] === end[1]) {
      cenAndAngles.sweep = TWO_PI;
    }
    var box = boundingBox.new();
    if (cenAndAngles != null) {
      pathGraph.add({
        type: "arc",
        start: cenAndAngles.start,
        end: cenAndAngles.end,
        center: cenAndAngles.center,
        sweep: cenAndAngles.sweep,
        radius: r,
        dir: mode
      });
      box = arcBox(cenAndAngles, r, region, tool, mode);
    } else {
      plotter._warn("skipping impossible arc");
    }
    return box;
  };
  var drawLine = function(start, end, tool, region, pathGraph) {
    pathGraph.add({ type: "line", start, end });
    if (!region) {
      var startBox = boundingBox.translate(tool.box, start);
      var endBox = boundingBox.translate(tool.box, end);
      return boundingBox.add(startBox, endBox);
    }
    var box = boundingBox.new();
    box = boundingBox.addPoint(box, start);
    box = boundingBox.addPoint(box, end);
    return box;
  };
  var interpolateRect = function(start, end, tool, pathGraph, plotter) {
    var hWidth = tool.trace[0] / 2;
    var hHeight = tool.trace[1] / 2;
    var theta = Math.atan2(end[1] - start[1], end[0] - start[0]);
    var sXMin = start[0] - hWidth;
    var sXMax = start[0] + hWidth;
    var sYMin = start[1] - hHeight;
    var sYMax = start[1] + hHeight;
    var eXMin = end[0] - hWidth;
    var eXMax = end[0] + hWidth;
    var eYMin = end[1] - hHeight;
    var eYMax = end[1] + hHeight;
    var points = [];
    if (start[0] === end[0] && start[1] === end[1]) {
      points.push([sXMin, sYMin], [sXMax, sYMin], [sXMax, sYMax], [sXMin, sYMax]);
    } else if (theta >= 0 && theta < HALF_PI) {
      points.push([sXMin, sYMin], [sXMax, sYMin], [eXMax, eYMin], [eXMax, eYMax], [eXMin, eYMax], [sXMin, sYMax]);
    } else if (theta >= HALF_PI && theta <= PI) {
      points.push([sXMax, sYMin], [sXMax, sYMax], [eXMax, eYMax], [eXMin, eYMax], [eXMin, eYMin], [sXMin, sYMin]);
    } else if (theta >= -PI && theta < -HALF_PI) {
      points.push([sXMax, sYMax], [sXMin, sYMax], [eXMin, eYMax], [eXMin, eYMin], [eXMax, eYMin], [sXMax, sYMin]);
    } else {
      points.push([sXMin, sYMax], [sXMin, sYMin], [eXMin, eYMin], [eXMax, eYMin], [eXMax, eYMax], [sXMax, sYMax]);
    }
    points.forEach(function(p, i2) {
      var j = i2 < points.length - 1 ? i2 + 1 : 0;
      pathGraph.add({ type: "line", start: p, end: points[j] });
    });
    plotter._finishPath();
    return boundingBox.add(boundingBox.translate(tool.box, start), boundingBox.translate(tool.box, end));
  };
  var interpolate = function(start, end, offset, tool, mode, arc, region, epsilon, pathGraph, plotter) {
    var strokableTool = region || tool && tool.trace.length > 0;
    var arcableTool = region || tool && tool.trace.length === 1;
    var toolCode = tool ? tool.code : "[NO TOOL SET]";
    if (!strokableTool) {
      plotter._warn("tool " + toolCode + " is not strokable; ignoring interpolate");
      return boundingBox.new();
    }
    if (mode === "i") {
      if (region || tool.trace.length === 1) {
        return drawLine(start, end, tool, region, pathGraph);
      }
      return interpolateRect(start, end, tool, pathGraph, plotter);
    }
    if (!arcableTool) {
      plotter._warn("cannot draw arc with non-circular tool " + toolCode + "; ignoring interpolate");
      return boundingBox.new();
    }
    return drawArc(start, end, offset, tool, mode, arc, region, epsilon, pathGraph, plotter);
  };
  var operate = function(type, coord, start, tool, mode, arc, region, pathGraph, epsilon, plotter) {
    var end = [
      coord.x != null ? coord.x : start[0],
      coord.y != null ? coord.y : start[1]
    ];
    var offset = [
      coord.i != null ? coord.i : 0,
      coord.j != null ? coord.j : 0,
      coord.a
    ];
    var box;
    switch (type) {
      case "flash":
        box = flash(end, tool, region, plotter);
        break;
      case "int":
        box = interpolate(start, end, offset, tool, mode, arc, region, epsilon, pathGraph, plotter);
        break;
      default:
        box = boundingBox.new();
        break;
    }
    return {
      pos: end,
      box
    };
  };
  module.exports = operate;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/lib/plotter.js
var require_plotter = __commonJS((exports, module) => {
  var Transform = require_readable_browser().Transform;
  var inherits2 = require_inherits_browser();
  var PathGraph = require_path_graph();
  var warning = require__warning2();
  var padShape = require__pad_shape();
  var operate = require__operate();
  var boundingBox = require__box();
  var MAX_GAP = 0.00011;
  var isFormatKey = function(key) {
    return key === "units" || key === "backupUnits" || key === "nota" || key === "backupNota";
  };
  var Plotter = function(units, backupUnits, nota, backupNota, optimizePaths, plotAsOutline) {
    Transform.call(this, {
      readableObjectMode: true,
      writableObjectMode: true
    });
    this.format = {
      units,
      backupUnits: backupUnits || "in",
      nota,
      backupNota: backupNota || "A"
    };
    this._formatLock = {
      units: units != null,
      backupUnits: backupUnits != null,
      nota: nota != null,
      backupNota: backupNota != null
    };
    this._plotAsOutline = plotAsOutline === true ? MAX_GAP : plotAsOutline;
    if ((units || this.format.backupUnits) === "in") {
      this._plotAsOutline = this._plotAsOutline / 25.4;
    }
    this._optimizePaths = optimizePaths || plotAsOutline;
    this._line = 0;
    this._done = false;
    this._tool = null;
    this._outTool = null;
    this._tools = {};
    this._macros = {};
    this._pos = [0, 0];
    this._box = boundingBox.new();
    this._mode = null;
    this._arc = null;
    this._region = false;
    this._path = new PathGraph(this._optimizePaths, this._plotAsOutline);
    this._epsilon = null;
    this._lastOp = null;
    this._stepRep = [];
  };
  inherits2(Plotter, Transform);
  Plotter.prototype._finishPath = function(doNotOptimize) {
    var path = this._path.traverse();
    this._path = new PathGraph(!doNotOptimize && this._optimizePaths, this._plotAsOutline);
    if (path.length) {
      var tool = !this._plotAsOutline ? this._tool : this._outTool;
      if (!this._region && tool.trace.length === 1) {
        this.push({ type: "stroke", width: tool.trace[0], path });
      } else {
        this.push({ type: "fill", path });
      }
    }
  };
  Plotter.prototype._warn = function(message) {
    this.emit("warning", warning(message, this._line));
  };
  Plotter.prototype._checkFormat = function() {
    if (!this.format.units) {
      this.format.units = this.format.backupUnits;
      this._warn("units not set; using backup units: " + this.format.units);
    }
    if (!this.format.nota) {
      this.format.nota = this.format.backupNota;
      this._warn("notation not set; using backup notation: " + this.format.nota);
    }
  };
  Plotter.prototype._updateBox = function(box) {
    var stepRepLen = this._stepRep.length;
    if (!stepRepLen) {
      this._box = boundingBox.add(this._box, box);
    } else {
      var repeatBox = boundingBox.repeat(box, this._stepRep[stepRepLen - 1]);
      this._box = boundingBox.add(this._box, repeatBox);
    }
  };
  Plotter.prototype._transform = function(chunk, encoding, done) {
    var type = chunk.type;
    this._line = chunk.line;
    if (this._done) {
      this._warn("ignoring extra command recieved after done command");
      return done();
    }
    if (type === "op") {
      this._checkFormat();
      var op = chunk.op;
      var coord = chunk.coord;
      if (this.nota === "I") {
        var _this = this;
        coord = Object.keys(coord).reduce(function(result2, key) {
          var value2 = coord[key];
          if (key === "x") {
            result2[key] = _this._pos[0] + value2;
          } else if (key === "y") {
            result2[key] = _this._pos[1] + value2;
          } else {
            result2[key] = value2;
          }
          return result2;
        }, {});
      }
      if (op === "last") {
        this._warn("modal operation commands are deprecated");
        op = this._lastOp;
      }
      if (op === "int") {
        if (this._mode == null) {
          this._warn("no interpolation mode specified; assuming linear");
          this._mode = "i";
        }
        if (this._arc == null && this._mode.slice(-2) === "cw" && !coord.a) {
          this._warn("quadrant mode unspecified; assuming single quadrant");
          this._arc = "s";
        }
      }
      if (this._plotAsOutline) {
        this._outTool = this._tool;
      }
      var result = operate(op, coord, this._pos, this._tool, this._mode, this._arc, this._region || this._plotAsOutline, this._path, this._epsilon, this);
      this._lastOp = op;
      this._pos = result.pos;
      this._updateBox(result.box);
    } else if (type === "set") {
      var prop = chunk.prop;
      var value = chunk.value;
      if (prop === "region") {
        this._finishPath(value);
        this._region = value;
      } else if (isFormatKey(prop) && !this._formatLock[prop]) {
        this.format[prop] = value;
        if (prop === "units" || prop === "nota") {
          this._formatLock[prop] = true;
        }
      } else if (prop === "tool") {
        if (this._region) {
          this._warn("cannot change tool while region mode is on");
        } else if (!this._tools[value]) {
          this._warn("tool " + value + " is not defined");
        } else if (!this._outTool) {
          this._finishPath();
          this._tool = this._tools[value];
        }
      } else {
        this["_" + prop] = value;
      }
    } else if (type === "tool") {
      var code2 = chunk.code;
      var toolDef = chunk.tool;
      if (this._tools[code2]) {
        this._warn("tool " + code2 + " is already defined; overwriting definition");
      }
      var shapeAndBox = padShape(toolDef, this._macros);
      var tool = {
        code: code2,
        trace: [],
        pad: shapeAndBox.shape,
        flashed: false,
        box: shapeAndBox.box
      };
      if (toolDef.shape === "circle" || toolDef.shape === "rect") {
        if (toolDef.hole.length === 0) {
          tool.trace = toolDef.params;
        }
      }
      if (!this._outTool) {
        this._finishPath();
        this._tools[code2] = tool;
        this._tool = tool;
      }
    } else if (type === "macro") {
      this._macros[chunk.name] = chunk.blocks;
    } else if (type === "level") {
      var level = chunk.level;
      var levelValue = chunk.value;
      this._finishPath();
      if (level === "polarity") {
        this.push({
          type: "polarity",
          polarity: levelValue === "C" ? "clear" : "dark",
          box: this._box.slice(0)
        });
      } else {
        var offsets = [];
        if (levelValue.x > 1 || levelValue.y > 1) {
          for (var x = 0;x < levelValue.x; x++) {
            for (var y = 0;y < levelValue.y; y++) {
              offsets.push([x * levelValue.i, y * levelValue.j]);
            }
          }
        }
        this._stepRep = offsets;
        this.push({
          type: "repeat",
          offsets: this._stepRep.slice(0),
          box: this._box.slice(0)
        });
      }
    } else if (type === "done") {
      this._done = true;
    }
    return done();
  };
  Plotter.prototype._flush = function(done) {
    this._finishPath();
    this.push({ type: "size", box: this._box, units: this.format.units });
    done();
  };
  module.exports = Plotter;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-plotter/index.js
var require_gerber_plotter = __commonJS((exports, module) => {
  var Plotter = require_plotter();
  var verifyNota = function(nota) {
    if (nota === "A" || nota === "I") {
      return nota;
    }
    throw new Error('notation must be "in" or "mm"');
  };
  var verifyUnits = function(units) {
    if (units === "in" || units === "mm") {
      return units;
    }
    throw new Error('units must be "in" or "mm"');
  };
  module.exports = function plotterFactory(options) {
    options = options || {};
    var units = options.units ? verifyUnits(options.units) : null;
    var backupUnits = options.backupUnits ? verifyUnits(options.backupUnits) : null;
    var nota = options.nota ? verifyNota(options.nota) : null;
    var backupNota = options.backupNota ? verifyNota(options.backupNota) : null;
    return new Plotter(units, backupUnits, nota, backupNota, options.optimizePaths, options.plotAsOutline);
  };
});

// ../../../../Development/anvil/anvild/node_modules/escape-html/index.js
var require_escape_html = __commonJS((exports, module) => {
  /*!
   * escape-html
   * Copyright(c) 2012-2013 TJ Holowaychuk
   * Copyright(c) 2015 Andreas Lubbe
   * Copyright(c) 2015 Tiancheng "Timothy" Gu
   * MIT Licensed
   */
  var matchHtmlRegExp = /["'&<>]/;
  module.exports = escapeHtml;
  function escapeHtml(string) {
    var str = "" + string;
    var match = matchHtmlRegExp.exec(str);
    if (!match) {
      return str;
    }
    var escape;
    var html = "";
    var index = 0;
    var lastIndex = 0;
    for (index = match.index;index < str.length; index++) {
      switch (str.charCodeAt(index)) {
        case 34:
          escape = "&quot;";
          break;
        case 38:
          escape = "&amp;";
          break;
        case 39:
          escape = "&#39;";
          break;
        case 60:
          escape = "&lt;";
          break;
        case 62:
          escape = "&gt;";
          break;
        default:
          continue;
      }
      if (lastIndex !== index) {
        html += str.substring(lastIndex, index);
      }
      lastIndex = index + 1;
      html += escape;
    }
    return lastIndex !== index ? html + str.substring(lastIndex, index) : html;
  }
});

// ../../../../Development/anvil/anvild/node_modules/xml-element-string/index.js
var require_xml_element_string = __commonJS((exports, module) => {
  var escapeHtml = require_escape_html();
  module.exports = function createXmlString(tag, attributes, children) {
    attributes = attributes || {};
    children = children || [];
    var start = "<" + escapeHtml(tag);
    var middle = Object.keys(attributes).reduce(function(result, key) {
      var value = attributes[key];
      var attr = value != null ? " " + escapeHtml(key) + '="' + escapeHtml(value) + '"' : "";
      return result + attr;
    }, "");
    var end = children.length ? ">" + children.join("") + "</" + tag + ">" : "/>";
    return start + middle + end;
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/lib/_util.js
var require__util = __commonJS((exports, module) => {
  var shift = function(number) {
    return Math.round(10000000000 * number) / 1e7;
  };
  var boundingRect = function(box, fill, element) {
    return element("rect", {
      x: shift(box[0]),
      y: shift(box[1]),
      width: shift(box[2] - box[0]),
      height: shift(box[3] - box[1]),
      fill
    });
  };
  var maskLayer = function(maskId, layer, element) {
    var maskUrl = "url(#" + maskId + ")";
    return element("g", { mask: maskUrl }, layer);
  };
  var createMask = function(maskId, box, children, element) {
    children = [boundingRect(box, "#fff", element)].concat(children);
    var attributes = { id: maskId, fill: "#000", stroke: "#000" };
    return element("mask", attributes, [element("g", {}, children)]);
  };
  module.exports = {
    shift,
    maskLayer,
    createMask
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/lib/_reduce-shape.js
var require__reduce_shape = __commonJS((exports, module) => {
  var util = require__util();
  var shift = util.shift;
  var createMask = util.createMask;
  var maskLayer = util.maskLayer;
  var element = function(tag, attr, children) {
    return { tag, attr, children: children || [] };
  };
  var circle = function(cx, cy, r, width) {
    var attr = {
      cx: shift(cx),
      cy: shift(cy),
      r: shift(r)
    };
    if (width != null) {
      attr["stroke-width"] = shift(width);
      attr.fill = "none";
    }
    return element("circle", attr);
  };
  var rect = function(cx, cy, r, width, height) {
    var attr = {
      x: shift(cx - width / 2),
      y: shift(cy - height / 2),
      width: shift(width),
      height: shift(height)
    };
    if (r) {
      attr.rx = shift(r);
      attr.ry = shift(r);
    }
    return element("rect", attr);
  };
  var poly = function(points) {
    var pointsAttr = points.map(function(point) {
      return point.map(shift).join(",");
    }).join(" ");
    return element("polygon", { points: pointsAttr });
  };
  var clip = function(maskIdPrefix, index, shapes, ring, createElement) {
    var maskId = maskIdPrefix + "mask-" + index;
    var maskUrl = "url(#" + maskId + ")";
    var circleNode = circle(ring.cx, ring.cy, ring.r, ring.width);
    var mask = createElement("mask", { id: maskId, stroke: "#fff" }, [
      createElement(circleNode.tag, circleNode.attr)
    ]);
    var groupChildren = shapes.map(function(shape) {
      var node = shape.type === "rect" ? rect(shape.cx, shape.cy, shape.r, shape.width, shape.height) : poly(shape.points);
      return createElement(node.tag, node.attr);
    });
    var layer = element("g", { mask: maskUrl }, groupChildren);
    return { mask, layer };
  };
  module.exports = function reduceShapeArray(prefix, code2, shapeArray, createElement) {
    var id = prefix + "_pad-" + code2;
    var maskIdPrefix = id + "_";
    var image = shapeArray.reduce(function(result, shape, index) {
      var svg;
      switch (shape.type) {
        case "circle":
          svg = circle(shape.cx, shape.cy, shape.r);
          break;
        case "ring":
          svg = circle(shape.cx, shape.cy, shape.r, shape.width);
          break;
        case "rect":
          svg = rect(shape.cx, shape.cy, shape.r, shape.width, shape.height);
          break;
        case "poly":
          svg = poly(shape.points);
          break;
        case "clip":
          var clipNodes = clip(maskIdPrefix, index, shape.shape, shape.clip, createElement);
          result.masks.push(clipNodes.mask);
          svg = clipNodes.layer;
          break;
        case "layer":
          result.count++;
          result.last = shape.polarity;
          if (shape.polarity === "clear") {
            var nextMaskId = maskIdPrefix + result.count;
            result.maskId = nextMaskId;
            result.maskBox = shape.box.slice(0);
            result.maskChildren = [];
            result.layers = [
              maskLayer(nextMaskId, result.layers, createElement)
            ];
          } else {
            var mask = createMask(result.maskId, result.maskBox, result.maskChildren, createElement);
            result.masks.push(mask);
          }
          break;
      }
      if (svg) {
        if (shapeArray.length === 1) {
          svg.attr.id = id;
        }
        var svgElement = createElement(svg.tag, svg.attr, svg.children);
        if (result.last === "dark") {
          result.layers.push(svgElement);
        } else {
          result.maskChildren.push(svgElement);
        }
      }
      return result;
    }, {
      count: 0,
      last: "dark",
      layers: [],
      maskId: "",
      maskBox: [],
      maskChildren: [],
      masks: []
    });
    if (image.last === "clear") {
      image.masks.push(createMask(image.maskId, image.maskBox, image.maskChildren, createElement));
    }
    if (shapeArray.length > 1) {
      image.layers = createElement("g", { id }, image.layers);
    }
    return image.masks.concat(image.layers);
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/lib/_flash-pad.js
var require__flash_pad = __commonJS((exports, module) => {
  var util = require__util();
  var shift = util.shift;
  module.exports = function flashPad(prefix, tool, x, y, element) {
    var toolId = "#" + prefix + "_pad-" + tool;
    return element("use", { "xlink:href": toolId, x: shift(x), y: shift(y) });
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/lib/_create-path.js
var require__create_path = __commonJS((exports, module) => {
  var util = require__util();
  var shift = util.shift;
  var pointsEqual = function(point, target) {
    return point[0] === target[0] && point[1] === target[1];
  };
  var move = function(start) {
    return "M " + shift(start[0]) + " " + shift(start[1]);
  };
  var line = function(lastCmd, end) {
    var cmd = lastCmd === "L" || lastCmd === "M" ? "" : "L ";
    return cmd + shift(end[0]) + " " + shift(end[1]);
  };
  var arc = function(lastCmd, radius, sweep, dir, end, center) {
    if (sweep === 0) {
      return line(lastCmd, end);
    }
    if (sweep === 2 * Math.PI) {
      var half = [2 * center[0] - end[0], 2 * center[1] - end[1]];
      var arc1 = arc(lastCmd, radius, Math.PI, dir, half, center);
      var arc2 = arc("A", radius, Math.PI, dir, end, center);
      return arc1 + " " + arc2;
    }
    var result = lastCmd === "A" ? "" : "A ";
    radius = shift(radius);
    result += radius + " " + radius + " 0 ";
    result += sweep > Math.PI ? "1 " : "0 ";
    result += dir === "ccw" ? "1 " : "0 ";
    result += shift(end[0]) + " " + shift(end[1]);
    return result;
  };
  var reduceSegments = function(result, segment) {
    var type = segment.type;
    var start = segment.start;
    var end = segment.end;
    if (!pointsEqual(result.last, start)) {
      result.data += (result.data ? " " : "") + move(start);
      result.lastCmd = "M";
    }
    result.data += " ";
    if (type === "line") {
      result.data += line(result.lastCmd, end);
      result.lastCmd = "L";
    } else {
      result.data += arc(result.lastCmd, segment.radius, segment.sweep, segment.dir, end, segment.center);
      result.lastCmd = "A";
    }
    result.last = end;
    return result;
  };
  module.exports = function createPath(segments, width, element) {
    var pathData = segments.reduce(reduceSegments, { last: [], data: "" }).data;
    var attr = { d: pathData };
    if (width != null) {
      attr.fill = "none";
      attr["stroke-width"] = shift(width);
    }
    return element("path", attr);
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/render.js
var require_render = __commonJS((exports, module) => {
  var xmlElementString = require_xml_element_string();
  module.exports = function(converter, attr, createElement) {
    var element = createElement || xmlElementString;
    var attributes = {
      version: "1.1",
      xmlns: "http://www.w3.org/2000/svg",
      "xmlns:xlink": "http://www.w3.org/1999/xlink",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "0",
      "fill-rule": "evenodd",
      width: converter.width + converter.units,
      height: converter.height + converter.units,
      viewBox: converter.viewBox.join(" ")
    };
    if (typeof attr === "string")
      attr = { id: attr };
    Object.keys(attr || {}).forEach(function(key) {
      var value = attr[key];
      if (value != null) {
        attributes[key] = value;
      }
    });
    var children = [];
    if (converter.layer.length) {
      if (converter.defs.length) {
        children.push(element("defs", {}, converter.defs));
      }
      var yTranslate = converter.viewBox[3] + 2 * converter.viewBox[1];
      var transform = "translate(0," + yTranslate + ") scale(1,-1)";
      children.push(element("g", {
        transform,
        fill: "currentColor",
        stroke: "currentColor"
      }, converter.layer));
    }
    return element("svg", attributes, children);
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/lib/plotter-to-svg.js
var require_plotter_to_svg = __commonJS((exports, module) => {
  var Transform = require_readable_browser().Transform;
  var inherits2 = require_inherits_browser();
  var isFinite2 = require_lodash();
  var reduceShapeArray = require__reduce_shape();
  var flashPad = require__flash_pad();
  var createPath = require__create_path();
  var util = require__util();
  var render = require_render();
  var shift = util.shift;
  var maskLayer = util.maskLayer;
  var createMask = util.createMask;
  var BLOCK_MODE_OFF = 0;
  var BLOCK_MODE_DARK = 1;
  var BLOCK_MODE_CLEAR = 2;
  var PlotterToSvg = function(id, attributes, createElement, objectMode) {
    Transform.call(this, {
      writableObjectMode: true,
      readableObjectMode: objectMode
    });
    this.id = id;
    this.attributes = attributes;
    this.defs = [];
    this.layer = [];
    this.viewBox = [0, 0, 0, 0];
    this.width = 0;
    this.height = 0;
    this.units = "";
    this._maskId = "";
    this._maskBox = [];
    this._mask = [];
    this._blockMode = false;
    this._blockBox = [];
    this._block = [];
    this._blockCount = 0;
    this._blockLayerCount = 0;
    this._offsets = [];
    this._clearCount = 0;
    this._lastLayer = 0;
    this._blockCount = 0;
    this._blockCount = 0;
    this._element = createElement;
  };
  inherits2(PlotterToSvg, Transform);
  PlotterToSvg.prototype._transform = function(chunk, encoding, done) {
    switch (chunk.type) {
      case "shape":
        this.defs = this.defs.concat(reduceShapeArray(this.id, chunk.tool, chunk.shape, this._element));
        break;
      case "pad":
        this._draw(flashPad(this.id, chunk.tool, chunk.x, chunk.y, this._element));
        break;
      case "fill":
        this._draw(createPath(chunk.path, null, this._element));
        break;
      case "stroke":
        this._draw(createPath(chunk.path, chunk.width, this._element));
        break;
      case "polarity":
        this._handleNewPolarity(chunk.polarity, chunk.box);
        break;
      case "repeat":
        this._handleNewRepeat(chunk.offsets, chunk.box);
        break;
      case "size":
        this._handleSize(chunk.box, chunk.units);
    }
    done();
  };
  PlotterToSvg.prototype._flush = function(done) {
    this._handleNewRepeat([]);
    this.push(render(this, this.attributes, this._element));
    done();
  };
  PlotterToSvg.prototype._finishBlockLayer = function() {
    if (this._block.length) {
      this._blockLayerCount++;
      var blockLayerId = this.id + "_block-" + this._blockCount + "-" + this._blockLayerCount;
      this.defs.push(this._element("g", { id: blockLayerId }, this._block));
      this._block = [];
    }
  };
  PlotterToSvg.prototype._finishClearLayer = function() {
    if (this._maskId) {
      this.defs.push(createMask(this._maskId, this._maskBox, this._mask, this._element));
      this._maskId = "";
      this._maskBox = [];
      this._mask = [];
      return true;
    }
    return false;
  };
  PlotterToSvg.prototype._handleNewPolarity = function(polarity, box) {
    if (this._blockMode) {
      if (this._blockLayerCount === 0 && !this._block.length) {
        this._blockMode = polarity === "dark" ? BLOCK_MODE_DARK : BLOCK_MODE_CLEAR;
      }
      return this._finishBlockLayer();
    }
    this._clearCount = polarity === "clear" ? this._clearCount + 1 : this._clearCount;
    var maskId = this.id + "_clear-" + this._clearCount;
    if (polarity === "clear") {
      this.layer = [maskLayer(maskId, this.layer, this._element)];
      this._maskId = maskId;
      this._maskBox = box.slice(0);
    } else {
      this._finishClearLayer(box);
    }
  };
  PlotterToSvg.prototype._handleNewRepeat = function(offsets, box) {
    var endOfBlock = offsets.length === 0;
    var wasClear = this._finishClearLayer();
    this._finishBlockLayer();
    var layer = this.layer;
    var element = this._element;
    var blockMode = this._blockMode;
    var blockLayers = this._blockLayerCount;
    var blockIdStart = this.id + "_block-" + this._blockCount + "-";
    this._offsets.forEach(function(offset) {
      for (var i2 = blockMode;i2 <= blockLayers; i2 += 2) {
        layer.push(element("use", {
          "xlink:href": "#" + blockIdStart + i2,
          x: shift(offset[0]),
          y: shift(offset[1])
        }));
      }
    });
    if (blockLayers > 2 - blockMode) {
      var maskId = blockIdStart + "clear";
      this.layer = [maskLayer(maskId, layer, this._element)];
      this._maskId = maskId;
      this._maskBox = this._blockBox.slice(0);
      this._mask = this._offsets.reduce(function(result, offset) {
        var isDark;
        for (var i2 = 1;i2 <= blockLayers; i2++) {
          isDark = blockMode === BLOCK_MODE_DARK ? i2 % 2 === 1 : i2 % 2 === 0;
          var attr = {
            "xlink:href": "#" + blockIdStart + i2,
            x: shift(offset[0]),
            y: shift(offset[1])
          };
          if (isDark) {
            attr.fill = "#fff";
            attr.stroke = "#fff";
          }
          result.push(element("use", attr));
        }
        return result;
      }, []);
      wasClear = this._finishClearLayer();
    }
    this._offsets = offsets;
    if (!endOfBlock) {
      this._blockMode = !wasClear ? BLOCK_MODE_DARK : BLOCK_MODE_CLEAR;
      this._blockCount++;
      this._blockLayerCount = 0;
      this._blockBox = box.every(isFinite2) ? box : [0, 0, 0, 0];
    } else {
      this._blockMode = BLOCK_MODE_OFF;
    }
  };
  PlotterToSvg.prototype._handleSize = function(box, units) {
    if (box.every(isFinite2)) {
      var x = shift(box[0]);
      var y = shift(box[1]);
      var width = shift(box[2] - box[0]);
      var height = shift(box[3] - box[1]);
      this.viewBox = [x, y, width, height];
      this.width = width / 1000;
      this.height = height / 1000;
      this.units = units;
    }
  };
  PlotterToSvg.prototype._draw = function(object) {
    if (!this._blockMode) {
      if (!this._maskId) {
        this.layer.push(object);
      } else {
        this._mask.push(object);
      }
    } else {
      this._block.push(object);
    }
  };
  module.exports = PlotterToSvg;
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/clone.js
var require_clone = __commonJS((exports, module) => {
  var KEYS = [
    "id",
    "attributes",
    "defs",
    "layer",
    "viewBox",
    "width",
    "height",
    "units"
  ];
  module.exports = function cloneConverter(converter) {
    return KEYS.reduce(function(result, key) {
      var value = converter[key];
      if (value != null) {
        result[key] = converter[key];
      }
      return result;
    }, {});
  };
});

// ../../../../Development/anvil/anvild/node_modules/gerber-to-svg/index.js
var require_gerber_to_svg = __commonJS((exports, module) => {
  var xid = require_xml_id();
  var gerberParser = require_gerber_parser();
  var gerberPlotter = require_gerber_plotter();
  var xmlElementString = require_xml_element_string();
  var PlotterToSvg = require_plotter_to_svg();
  var render = require_render();
  var clone = require_clone();
  var parseOptions = function(options) {
    if (typeof options === "string") {
      options = { id: options };
    } else if (!options) {
      options = {};
    }
    var opts = {
      id: xid.ensure(options.id),
      attributes: options.attributes || {},
      createElement: options.createElement || xmlElementString,
      objectMode: options.objectMode == null ? false : options.objectMode,
      parser: {
        places: options.places,
        zero: options.zero,
        filetype: options.filetype
      },
      plotter: {
        units: options.units,
        backupUnits: options.backupUnits,
        nota: options.nota,
        backupNota: options.backupNota,
        optimizePaths: options.optimizePaths,
        plotAsOutline: options.plotAsOutline
      }
    };
    return opts;
  };
  module.exports = function gerberConverterFactory(gerber, inputOpts, done) {
    if (typeof inputOpts === "function") {
      done = inputOpts;
      inputOpts = null;
    }
    var opts = parseOptions(inputOpts);
    var callbackMode = done != null;
    var converter = new PlotterToSvg(opts.id, opts.attributes, opts.createElement, opts.objectMode);
    var parser = gerberParser(opts.parser);
    var plotter = gerberPlotter(opts.plotter);
    converter.parser = parser;
    converter.plotter = plotter;
    parser.on("warning", function handleParserWarning(w) {
      converter.emit("warning", w);
    });
    plotter.on("warning", function handlePlotterWarning(w) {
      converter.emit("warning", w);
    });
    parser.once("error", function handleParserError(e) {
      converter.emit("error", e);
    });
    plotter.once("error", function handlePlotterError(e) {
      converter.emit("error", e);
    });
    parser.once("end", function() {
      converter.filetype = parser.format.filetype;
    });
    if (gerber.pipe) {
      gerber.setEncoding("utf8");
      gerber.pipe(parser);
    } else {
      process.nextTick(function writeStringToParser() {
        parser.write(gerber);
        parser.end();
      });
    }
    parser.pipe(plotter).pipe(converter);
    if (callbackMode) {
      var result = "";
      var finishConversion = function() {
        return done(null, result);
      };
      converter.on("readable", function collectStreamData() {
        var data;
        do {
          data = converter.read() || "";
          result += data;
        } while (data);
      });
      converter.once("end", finishConversion);
      converter.once("error", function(error) {
        converter.removeListener("end", finishConversion);
        return done(error);
      });
    }
    return converter;
  };
  module.exports.render = render;
  module.exports.clone = clone;
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/constants.js
var require_constants = __commonJS((exports, module) => {
  module.exports = {
    TYPE_COPPER: "copper",
    TYPE_SOLDERMASK: "soldermask",
    TYPE_SILKSCREEN: "silkscreen",
    TYPE_SOLDERPASTE: "solderpaste",
    TYPE_DRILL: "drill",
    TYPE_OUTLINE: "outline",
    TYPE_DRAWING: "drawing",
    SIDE_TOP: "top",
    SIDE_BOTTOM: "bottom",
    SIDE_INNER: "inner",
    SIDE_ALL: "all",
    _CAD_KICAD: "kicad",
    _CAD_ALTIUM: "altium",
    _CAD_ALLEGRO: "allegro",
    _CAD_EAGLE: "eagle",
    _CAD_EAGLE_LEGACY: "eagle-legacy",
    _CAD_EAGLE_OSHPARK: "eagle-oshpark",
    _CAD_EAGLE_PCBNG: "eagle-pcbng",
    _CAD_GEDA_PCB: "geda-pcb",
    _CAD_ORCAD: "orcad",
    _CAD_DIPTRACE: "diptrace"
  };
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/flat-map.js
var require_flat_map = __commonJS((exports, module) => {
  module.exports = function flatMap(collection, iterator) {
    return collection.reduce(function iterate(result, element) {
      return result.concat(iterator(element));
    }, []);
  };
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/get-common-cad.js
var require_get_common_cad = __commonJS((exports, module) => {
  module.exports = function getCommonCad(matches) {
    var cadCount = matches.reduce(function(counts, match) {
      counts[match.cad] = counts[match.cad] + 1 || 1;
      return counts;
    }, {});
    return Object.keys(cadCount).reduce(function(maxAndName, name) {
      var count = cadCount[name];
      if (count > maxAndName.max)
        return { max: count, name };
      return maxAndName;
    }, { max: 0, name: null }).name;
  };
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/layer-types.js
var require_layer_types = __commonJS((exports, module) => {
  var c = require_constants();
  module.exports = [
    {
      type: null,
      side: null,
      matchers: [
        {
          ext: "gpi",
          cad: [
            c._CAD_EAGLE,
            c._CAD_EAGLE_LEGACY,
            c._CAD_EAGLE_OSHPARK,
            c._CAD_EAGLE_PCBNG
          ]
        },
        {
          ext: "dri",
          cad: [
            c._CAD_EAGLE,
            c._CAD_EAGLE_LEGACY,
            c._CAD_EAGLE_OSHPARK,
            c._CAD_EAGLE_PCBNG
          ]
        },
        { ext: "csv", cad: null },
        { match: /pnp_bom/, cad: c._CAD_EAGLE_PCBNG }
      ]
    },
    {
      type: c.TYPE_COPPER,
      side: c.SIDE_TOP,
      matchers: [
        { ext: "cmp", cad: c._CAD_EAGLE_LEGACY },
        { ext: "top", cad: [c._CAD_EAGLE_LEGACY, c._CAD_ORCAD] },
        { ext: "gtl", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "toplayer\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /top\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /f[._]cu/, cad: c._CAD_KICAD },
        { match: /copper_top/, cad: c._CAD_EAGLE },
        { match: /top_copper/, cad: c._CAD_EAGLE_PCBNG },
        { match: /top copper/, cad: null }
      ]
    },
    {
      type: c.TYPE_SOLDERMASK,
      side: c.SIDE_TOP,
      matchers: [
        { ext: "stc", cad: c._CAD_EAGLE_LEGACY },
        { ext: "tsm", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gts", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "smt", cad: c._CAD_ORCAD },
        { ext: "topsoldermask\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /topmask\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /f[._]mask/, cad: c._CAD_KICAD },
        { match: /soldermask_top/, cad: c._CAD_EAGLE },
        { match: /top_mask/, cad: c._CAD_EAGLE_PCBNG },
        { match: /top solder resist/, cad: null }
      ]
    },
    {
      type: c.TYPE_SILKSCREEN,
      side: c.SIDE_TOP,
      matchers: [
        { ext: "plc", cad: c._CAD_EAGLE_LEGACY },
        { ext: "tsk", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gto", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "sst", cad: c._CAD_ORCAD },
        { ext: "topsilkscreen\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /topsilk\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /f[._]silks/, cad: c._CAD_KICAD },
        { match: /silkscreen_top/, cad: c._CAD_EAGLE },
        { match: /top_silk/, cad: c._CAD_EAGLE_PCBNG },
        { match: /top silk screen/, cad: null }
      ]
    },
    {
      type: c.TYPE_SOLDERPASTE,
      side: c.SIDE_TOP,
      matchers: [
        { ext: "crc", cad: c._CAD_EAGLE_LEGACY },
        { ext: "tsp", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gtp", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "spt", cad: c._CAD_ORCAD },
        { ext: "tcream\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /toppaste\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /f[._]paste/, cad: c._CAD_KICAD },
        { match: /solderpaste_top/, cad: c._CAD_EAGLE },
        { match: /top_paste/, cad: c._CAD_EAGLE_PCBNG }
      ]
    },
    {
      type: c.TYPE_COPPER,
      side: c.SIDE_BOTTOM,
      matchers: [
        { ext: "sol", cad: c._CAD_EAGLE_LEGACY },
        { ext: "bot", cad: [c._CAD_EAGLE_LEGACY, c._CAD_ORCAD] },
        { ext: "gbl", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "bottomlayer\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /bottom\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /b[._]cu/, cad: c._CAD_KICAD },
        { match: /copper_bottom/, cad: c._CAD_EAGLE },
        { match: /bottom_copper/, cad: c._CAD_EAGLE_PCBNG },
        { match: /bottom copper/, cad: null }
      ]
    },
    {
      type: c.TYPE_SOLDERMASK,
      side: c.SIDE_BOTTOM,
      matchers: [
        { ext: "sts", cad: c._CAD_EAGLE_LEGACY },
        { ext: "bsm", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gbs", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "smb", cad: c._CAD_ORCAD },
        { ext: "bottomsoldermask\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /bottommask\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /b[._]mask/, cad: c._CAD_KICAD },
        { match: /soldermask_bottom/, cad: c._CAD_EAGLE },
        { match: /bottom_mask/, cad: c._CAD_EAGLE_PCBNG },
        { match: /bottom solder resist/, cad: null }
      ]
    },
    {
      type: c.TYPE_SILKSCREEN,
      side: c.SIDE_BOTTOM,
      matchers: [
        { ext: "pls", cad: c._CAD_EAGLE_LEGACY },
        { ext: "bsk", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gbo", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "ssb", cad: c._CAD_ORCAD },
        { ext: "bottomsilkscreen\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /bottomsilk\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /b[._]silks/, cad: c._CAD_KICAD },
        { match: /silkscreen_bottom/, cad: c._CAD_EAGLE },
        { match: /bottom_silk/, cad: c._CAD_EAGLE_PCBNG },
        { match: /bottom silk screen/, cad: null }
      ]
    },
    {
      type: c.TYPE_SOLDERPASTE,
      side: c.SIDE_BOTTOM,
      matchers: [
        { ext: "crs", cad: c._CAD_EAGLE_LEGACY },
        { ext: "bsp", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gbp", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "spb", cad: c._CAD_ORCAD },
        { ext: "bcream\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /bottompaste\.\w+$/, cad: [c._CAD_GEDA_PCB, c._CAD_DIPTRACE] },
        { match: /b[._]paste/, cad: c._CAD_KICAD },
        { match: /solderpaste_bottom/, cad: c._CAD_EAGLE },
        { match: /bottom_paste/, cad: c._CAD_EAGLE_PCBNG }
      ]
    },
    {
      type: c.TYPE_COPPER,
      side: c.SIDE_INNER,
      matchers: [
        { ext: "ly\\d+", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gp?\\d+", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "in\\d+", cad: c._CAD_ORCAD },
        { ext: "internalplane\\d+\\.ger", cad: c._CAD_EAGLE_OSHPARK },
        { match: /in(?:ner)?\d+[._]cu/, cad: c._CAD_KICAD },
        { match: /inner/, cad: c._CAD_DIPTRACE }
      ]
    },
    {
      type: c.TYPE_OUTLINE,
      side: c.SIDE_ALL,
      matchers: [
        { ext: "dim", cad: c._CAD_EAGLE_LEGACY },
        { ext: "mil", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gml", cad: c._CAD_EAGLE_LEGACY },
        { ext: "gm\\d+", cad: [c._CAD_KICAD, c._CAD_ALTIUM] },
        { ext: "gko", cad: c._CAD_ALTIUM },
        { ext: "fab", cad: c._CAD_ORCAD },
        { ext: "drd", cad: c._CAD_ORCAD },
        { match: /outline/, cad: [c._CAD_GEDA_PCB, c._CAD_EAGLE_PCBNG] },
        { match: /boardoutline/, cad: [c._CAD_EAGLE_OSHPARK, c._CAD_DIPTRACE] },
        { match: /edge[._]cuts/, cad: c._CAD_KICAD },
        { match: /profile/, cad: c._CAD_EAGLE },
        { match: /mechanical \d+/, cad: null }
      ]
    },
    {
      type: c.TYPE_DRILL,
      side: c.SIDE_ALL,
      matchers: [
        { ext: "txt", cad: [c._CAD_EAGLE_LEGACY, c._CAD_ALTIUM] },
        {
          ext: "xln",
          cad: [c._CAD_EAGLE, c._CAD_EAGLE_LEGACY, c._CAD_EAGLE_OSHPARK]
        },
        { ext: "exc", cad: c._CAD_EAGLE_LEGACY },
        { ext: "drd", cad: c._CAD_EAGLE_LEGACY },
        { ext: "drl", cad: [c._CAD_KICAD, c._CAD_DIPTRACE] },
        { ext: "tap", cad: c._CAD_ORCAD },
        { ext: "npt", cad: c._CAD_ORCAD },
        { ext: "plated-drill\\.cnc", cad: c._CAD_GEDA_PCB },
        { match: /fab/, cad: c._CAD_GEDA_PCB },
        { match: /npth/, cad: c._CAD_KICAD },
        { match: "/drill/", cad: c._CAD_EAGLE_PCBNG }
      ]
    },
    {
      type: c.TYPE_DRAWING,
      side: null,
      matchers: [
        { ext: "pos", cad: c._CAD_KICAD },
        { ext: "art", cad: c._CAD_ALLEGRO },
        { ext: "gbr", cad: null },
        { ext: "gbx", cad: null },
        { ext: "ger", cad: null },
        { ext: "pho", cad: null }
      ]
    }
  ];
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/matchers.js
var require_matchers = __commonJS((exports, module) => {
  var flatMap = require_flat_map();
  var layerTypes = require_layer_types();
  module.exports = flatMap(layerTypes, layerTypeToMatchers);
  function layerTypeToMatchers(layer) {
    return flatMap(layer.matchers, matcherToCadMatchers);
    function matcherToCadMatchers(matcher) {
      var match = matcher.ext ? new RegExp("\\." + matcher.ext + "$", "i") : new RegExp(matcher.match, "i");
      return [].concat(matcher.cad).map(mergeLayerWithCad);
      function mergeLayerWithCad(cad) {
        return {
          type: layer.type,
          side: layer.side,
          match,
          cad
        };
      }
    }
  }
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/lib/get-matches.js
var require_get_matches = __commonJS((exports, module) => {
  var extend = require_immutable();
  var matchers = require_matchers();
  module.exports = function getMatches(filename) {
    return matchers.map(matcherToFileMatches).filter(Boolean);
    function matcherToFileMatches(matcher) {
      if (!matcher.match.test(filename))
        return null;
      return extend(matcher, { filename });
    }
  };
});

// ../../../../Development/anvil/anvild/node_modules/whats-that-gerber/index.js
var require_whats_that_gerber = __commonJS((exports, module) => {
  var constants2 = require_constants();
  var flatMap = require_flat_map();
  var getCommonCad = require_get_common_cad();
  var getMatches = require_get_matches();
  var layerTypes = require_layer_types();
  module.exports = whatsThatGerber;
  module.exports.validate = validate;
  module.exports.getAllLayers = getAllLayers;
  Object.keys(constants2).forEach(function(constantName) {
    module.exports[constantName] = constants2[constantName];
  });
  function whatsThatGerber(filenames) {
    if (typeof filenames === "string")
      filenames = [filenames];
    var matches = flatMap(filenames, getMatches);
    var commonCad = getCommonCad(matches);
    return filenames.reduce(function(result, filename) {
      var match = _selectMatch(matches, filename, commonCad);
      result[filename] = match ? { type: match.type, side: match.side } : { type: null, side: null };
      return result;
    }, {});
  }
  function getAllLayers() {
    return layerTypes.map(function(layer) {
      return { type: layer.type, side: layer.side };
    }).filter(function(layer) {
      return layer.type !== null;
    });
  }
  function validate(target) {
    return {
      valid: layerTypes.some(_validateLayer),
      side: layerTypes.some(_validateSide) ? target.side : null,
      type: layerTypes.some(_validateType) ? target.type : null
    };
    function _validateLayer(layer) {
      return layer.side === target.side && layer.type === target.type;
    }
    function _validateSide(layer) {
      return layer.side === target.side;
    }
    function _validateType(layer) {
      return layer.type === target.type;
    }
  }
  function _selectMatch(matches, filename, cad) {
    var filenameMatches = matches.filter(function(match) {
      return match.filename === filename;
    });
    var result = filenameMatches.find(function(match) {
      return match.cad === cad;
    });
    return result || filenameMatches[0] || null;
  }
});

// ../../../../Development/anvil/anvild/node_modules/viewbox/index.js
var require_viewbox = __commonJS((exports, module) => {
  module.exports = {
    create: function createViewbox() {
      return [];
    },
    add: function addViewboxes(box, addend) {
      if (!box.length) {
        return addend;
      }
      if (!addend.length) {
        return box;
      }
      var xMin = Math.min(box[0], addend[0]);
      var yMin = Math.min(box[1], addend[1]);
      var xMax = Math.max(box[0] + box[2], addend[0] + addend[2]);
      var yMax = Math.max(box[1] + box[3], addend[1] + addend[3]);
      return [xMin, yMin, xMax - xMin, yMax - yMin];
    },
    scale: function scaleViewboxes(box, scale) {
      return box.map(function(component) {
        return component * scale;
      });
    },
    rect: function viewboxRect(box) {
      box = box && box.length ? box : [0, 0, 0, 0];
      return {
        x: box[0],
        y: box[1],
        width: box[2],
        height: box[3]
      };
    },
    asString: function(box) {
      box = box && box.length ? box : [0, 0, 0, 0];
      return box.join(" ");
    }
  };
});

// ../../../../Development/anvil/anvild/node_modules/color-name/index.js
var require_color_name = __commonJS((exports, module) => {
  module.exports = {
    aliceblue: [240, 248, 255],
    antiquewhite: [250, 235, 215],
    aqua: [0, 255, 255],
    aquamarine: [127, 255, 212],
    azure: [240, 255, 255],
    beige: [245, 245, 220],
    bisque: [255, 228, 196],
    black: [0, 0, 0],
    blanchedalmond: [255, 235, 205],
    blue: [0, 0, 255],
    blueviolet: [138, 43, 226],
    brown: [165, 42, 42],
    burlywood: [222, 184, 135],
    cadetblue: [95, 158, 160],
    chartreuse: [127, 255, 0],
    chocolate: [210, 105, 30],
    coral: [255, 127, 80],
    cornflowerblue: [100, 149, 237],
    cornsilk: [255, 248, 220],
    crimson: [220, 20, 60],
    cyan: [0, 255, 255],
    darkblue: [0, 0, 139],
    darkcyan: [0, 139, 139],
    darkgoldenrod: [184, 134, 11],
    darkgray: [169, 169, 169],
    darkgreen: [0, 100, 0],
    darkgrey: [169, 169, 169],
    darkkhaki: [189, 183, 107],
    darkmagenta: [139, 0, 139],
    darkolivegreen: [85, 107, 47],
    darkorange: [255, 140, 0],
    darkorchid: [153, 50, 204],
    darkred: [139, 0, 0],
    darksalmon: [233, 150, 122],
    darkseagreen: [143, 188, 143],
    darkslateblue: [72, 61, 139],
    darkslategray: [47, 79, 79],
    darkslategrey: [47, 79, 79],
    darkturquoise: [0, 206, 209],
    darkviolet: [148, 0, 211],
    deeppink: [255, 20, 147],
    deepskyblue: [0, 191, 255],
    dimgray: [105, 105, 105],
    dimgrey: [105, 105, 105],
    dodgerblue: [30, 144, 255],
    firebrick: [178, 34, 34],
    floralwhite: [255, 250, 240],
    forestgreen: [34, 139, 34],
    fuchsia: [255, 0, 255],
    gainsboro: [220, 220, 220],
    ghostwhite: [248, 248, 255],
    gold: [255, 215, 0],
    goldenrod: [218, 165, 32],
    gray: [128, 128, 128],
    green: [0, 128, 0],
    greenyellow: [173, 255, 47],
    grey: [128, 128, 128],
    honeydew: [240, 255, 240],
    hotpink: [255, 105, 180],
    indianred: [205, 92, 92],
    indigo: [75, 0, 130],
    ivory: [255, 255, 240],
    khaki: [240, 230, 140],
    lavender: [230, 230, 250],
    lavenderblush: [255, 240, 245],
    lawngreen: [124, 252, 0],
    lemonchiffon: [255, 250, 205],
    lightblue: [173, 216, 230],
    lightcoral: [240, 128, 128],
    lightcyan: [224, 255, 255],
    lightgoldenrodyellow: [250, 250, 210],
    lightgray: [211, 211, 211],
    lightgreen: [144, 238, 144],
    lightgrey: [211, 211, 211],
    lightpink: [255, 182, 193],
    lightsalmon: [255, 160, 122],
    lightseagreen: [32, 178, 170],
    lightskyblue: [135, 206, 250],
    lightslategray: [119, 136, 153],
    lightslategrey: [119, 136, 153],
    lightsteelblue: [176, 196, 222],
    lightyellow: [255, 255, 224],
    lime: [0, 255, 0],
    limegreen: [50, 205, 50],
    linen: [250, 240, 230],
    magenta: [255, 0, 255],
    maroon: [128, 0, 0],
    mediumaquamarine: [102, 205, 170],
    mediumblue: [0, 0, 205],
    mediumorchid: [186, 85, 211],
    mediumpurple: [147, 112, 219],
    mediumseagreen: [60, 179, 113],
    mediumslateblue: [123, 104, 238],
    mediumspringgreen: [0, 250, 154],
    mediumturquoise: [72, 209, 204],
    mediumvioletred: [199, 21, 133],
    midnightblue: [25, 25, 112],
    mintcream: [245, 255, 250],
    mistyrose: [255, 228, 225],
    moccasin: [255, 228, 181],
    navajowhite: [255, 222, 173],
    navy: [0, 0, 128],
    oldlace: [253, 245, 230],
    olive: [128, 128, 0],
    olivedrab: [107, 142, 35],
    orange: [255, 165, 0],
    orangered: [255, 69, 0],
    orchid: [218, 112, 214],
    palegoldenrod: [238, 232, 170],
    palegreen: [152, 251, 152],
    paleturquoise: [175, 238, 238],
    palevioletred: [219, 112, 147],
    papayawhip: [255, 239, 213],
    peachpuff: [255, 218, 185],
    peru: [205, 133, 63],
    pink: [255, 192, 203],
    plum: [221, 160, 221],
    powderblue: [176, 224, 230],
    purple: [128, 0, 128],
    rebeccapurple: [102, 51, 153],
    red: [255, 0, 0],
    rosybrown: [188, 143, 143],
    royalblue: [65, 105, 225],
    saddlebrown: [139, 69, 19],
    salmon: [250, 128, 114],
    sandybrown: [244, 164, 96],
    seagreen: [46, 139, 87],
    seashell: [255, 245, 238],
    sienna: [160, 82, 45],
    silver: [192, 192, 192],
    skyblue: [135, 206, 235],
    slateblue: [106, 90, 205],
    slategray: [112, 128, 144],
    slategrey: [112, 128, 144],
    snow: [255, 250, 250],
    springgreen: [0, 255, 127],
    steelblue: [70, 130, 180],
    tan: [210, 180, 140],
    teal: [0, 128, 128],
    thistle: [216, 191, 216],
    tomato: [255, 99, 71],
    turquoise: [64, 224, 208],
    violet: [238, 130, 238],
    wheat: [245, 222, 179],
    white: [255, 255, 255],
    whitesmoke: [245, 245, 245],
    yellow: [255, 255, 0],
    yellowgreen: [154, 205, 50]
  };
});

// ../../../../Development/anvil/anvild/node_modules/is-arrayish/index.js
var require_is_arrayish = __commonJS((exports, module) => {
  module.exports = function isArrayish(obj) {
    if (!obj || typeof obj === "string") {
      return false;
    }
    return obj instanceof Array || Array.isArray(obj) || obj.length >= 0 && (obj.splice instanceof Function || Object.getOwnPropertyDescriptor(obj, obj.length - 1) && obj.constructor.name !== "String");
  };
});

// ../../../../Development/anvil/anvild/node_modules/simple-swizzle/index.js
var require_simple_swizzle = __commonJS((exports, module) => {
  var isArrayish = require_is_arrayish();
  var concat = Array.prototype.concat;
  var slice = Array.prototype.slice;
  var swizzle = module.exports = function swizzle2(args) {
    var results = [];
    for (var i2 = 0, len2 = args.length;i2 < len2; i2++) {
      var arg = args[i2];
      if (isArrayish(arg)) {
        results = concat.call(results, slice.call(arg));
      } else {
        results.push(arg);
      }
    }
    return results;
  };
  swizzle.wrap = function(fn) {
    return function() {
      return fn(swizzle(arguments));
    };
  };
});

// ../../../../Development/anvil/anvild/node_modules/color-string/index.js
var require_color_string = __commonJS((exports, module) => {
  var colorNames = require_color_name();
  var swizzle = require_simple_swizzle();
  var hasOwnProperty2 = Object.hasOwnProperty;
  var reverseNames = Object.create(null);
  for (name in colorNames) {
    if (hasOwnProperty2.call(colorNames, name)) {
      reverseNames[colorNames[name]] = name;
    }
  }
  var name;
  var cs = module.exports = {
    to: {},
    get: {}
  };
  cs.get = function(string) {
    var prefix = string.substring(0, 3).toLowerCase();
    var val;
    var model;
    switch (prefix) {
      case "hsl":
        val = cs.get.hsl(string);
        model = "hsl";
        break;
      case "hwb":
        val = cs.get.hwb(string);
        model = "hwb";
        break;
      default:
        val = cs.get.rgb(string);
        model = "rgb";
        break;
    }
    if (!val) {
      return null;
    }
    return { model, value: val };
  };
  cs.get.rgb = function(string) {
    if (!string) {
      return null;
    }
    var abbr = /^#([a-f0-9]{3,4})$/i;
    var hex = /^#([a-f0-9]{6})([a-f0-9]{2})?$/i;
    var rgba = /^rgba?\(\s*([+-]?\d+)(?=[\s,])\s*(?:,\s*)?([+-]?\d+)(?=[\s,])\s*(?:,\s*)?([+-]?\d+)\s*(?:[,|\/]\s*([+-]?[\d\.]+)(%?)\s*)?\)$/;
    var per = /^rgba?\(\s*([+-]?[\d\.]+)\%\s*,?\s*([+-]?[\d\.]+)\%\s*,?\s*([+-]?[\d\.]+)\%\s*(?:[,|\/]\s*([+-]?[\d\.]+)(%?)\s*)?\)$/;
    var keyword = /^(\w+)$/;
    var rgb = [0, 0, 0, 1];
    var match;
    var i2;
    var hexAlpha;
    if (match = string.match(hex)) {
      hexAlpha = match[2];
      match = match[1];
      for (i2 = 0;i2 < 3; i2++) {
        var i22 = i2 * 2;
        rgb[i2] = parseInt(match.slice(i22, i22 + 2), 16);
      }
      if (hexAlpha) {
        rgb[3] = parseInt(hexAlpha, 16) / 255;
      }
    } else if (match = string.match(abbr)) {
      match = match[1];
      hexAlpha = match[3];
      for (i2 = 0;i2 < 3; i2++) {
        rgb[i2] = parseInt(match[i2] + match[i2], 16);
      }
      if (hexAlpha) {
        rgb[3] = parseInt(hexAlpha + hexAlpha, 16) / 255;
      }
    } else if (match = string.match(rgba)) {
      for (i2 = 0;i2 < 3; i2++) {
        rgb[i2] = parseInt(match[i2 + 1], 0);
      }
      if (match[4]) {
        if (match[5]) {
          rgb[3] = parseFloat(match[4]) * 0.01;
        } else {
          rgb[3] = parseFloat(match[4]);
        }
      }
    } else if (match = string.match(per)) {
      for (i2 = 0;i2 < 3; i2++) {
        rgb[i2] = Math.round(parseFloat(match[i2 + 1]) * 2.55);
      }
      if (match[4]) {
        if (match[5]) {
          rgb[3] = parseFloat(match[4]) * 0.01;
        } else {
          rgb[3] = parseFloat(match[4]);
        }
      }
    } else if (match = string.match(keyword)) {
      if (match[1] === "transparent") {
        return [0, 0, 0, 0];
      }
      if (!hasOwnProperty2.call(colorNames, match[1])) {
        return null;
      }
      rgb = colorNames[match[1]];
      rgb[3] = 1;
      return rgb;
    } else {
      return null;
    }
    for (i2 = 0;i2 < 3; i2++) {
      rgb[i2] = clamp(rgb[i2], 0, 255);
    }
    rgb[3] = clamp(rgb[3], 0, 1);
    return rgb;
  };
  cs.get.hsl = function(string) {
    if (!string) {
      return null;
    }
    var hsl = /^hsla?\(\s*([+-]?(?:\d{0,3}\.)?\d+)(?:deg)?\s*,?\s*([+-]?[\d\.]+)%\s*,?\s*([+-]?[\d\.]+)%\s*(?:[,|\/]\s*([+-]?(?=\.\d|\d)(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*)?\)$/;
    var match = string.match(hsl);
    if (match) {
      var alpha = parseFloat(match[4]);
      var h = (parseFloat(match[1]) % 360 + 360) % 360;
      var s = clamp(parseFloat(match[2]), 0, 100);
      var l = clamp(parseFloat(match[3]), 0, 100);
      var a = clamp(isNaN(alpha) ? 1 : alpha, 0, 1);
      return [h, s, l, a];
    }
    return null;
  };
  cs.get.hwb = function(string) {
    if (!string) {
      return null;
    }
    var hwb = /^hwb\(\s*([+-]?\d{0,3}(?:\.\d+)?)(?:deg)?\s*,\s*([+-]?[\d\.]+)%\s*,\s*([+-]?[\d\.]+)%\s*(?:,\s*([+-]?(?=\.\d|\d)(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*)?\)$/;
    var match = string.match(hwb);
    if (match) {
      var alpha = parseFloat(match[4]);
      var h = (parseFloat(match[1]) % 360 + 360) % 360;
      var w = clamp(parseFloat(match[2]), 0, 100);
      var b = clamp(parseFloat(match[3]), 0, 100);
      var a = clamp(isNaN(alpha) ? 1 : alpha, 0, 1);
      return [h, w, b, a];
    }
    return null;
  };
  cs.to.hex = function() {
    var rgba = swizzle(arguments);
    return "#" + hexDouble(rgba[0]) + hexDouble(rgba[1]) + hexDouble(rgba[2]) + (rgba[3] < 1 ? hexDouble(Math.round(rgba[3] * 255)) : "");
  };
  cs.to.rgb = function() {
    var rgba = swizzle(arguments);
    return rgba.length < 4 || rgba[3] === 1 ? "rgb(" + Math.round(rgba[0]) + ", " + Math.round(rgba[1]) + ", " + Math.round(rgba[2]) + ")" : "rgba(" + Math.round(rgba[0]) + ", " + Math.round(rgba[1]) + ", " + Math.round(rgba[2]) + ", " + rgba[3] + ")";
  };
  cs.to.rgb.percent = function() {
    var rgba = swizzle(arguments);
    var r = Math.round(rgba[0] / 255 * 100);
    var g = Math.round(rgba[1] / 255 * 100);
    var b = Math.round(rgba[2] / 255 * 100);
    return rgba.length < 4 || rgba[3] === 1 ? "rgb(" + r + "%, " + g + "%, " + b + "%)" : "rgba(" + r + "%, " + g + "%, " + b + "%, " + rgba[3] + ")";
  };
  cs.to.hsl = function() {
    var hsla = swizzle(arguments);
    return hsla.length < 4 || hsla[3] === 1 ? "hsl(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%)" : "hsla(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%, " + hsla[3] + ")";
  };
  cs.to.hwb = function() {
    var hwba = swizzle(arguments);
    var a = "";
    if (hwba.length >= 4 && hwba[3] !== 1) {
      a = ", " + hwba[3];
    }
    return "hwb(" + hwba[0] + ", " + hwba[1] + "%, " + hwba[2] + "%" + a + ")";
  };
  cs.to.keyword = function(rgb) {
    return reverseNames[rgb.slice(0, 3)];
  };
  function clamp(num, min, max) {
    return Math.min(Math.max(min, num), max);
  }
  function hexDouble(num) {
    var str = Math.round(num).toString(16).toUpperCase();
    return str.length < 2 ? "0" + str : str;
  }
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/board-color.js
var require_board_color = __commonJS((exports, module) => {
  var colorString = require_color_string();
  var LAYER_IDS = ["fr4", "cu", "cf", "sm", "ss", "sp", "out"];
  var DEFAULTS = {
    fr4: "#666666",
    cu: "#cccccc",
    cf: "#cc9933",
    sm: "#004200bf",
    ss: "#ffffff",
    sp: "#999999",
    out: "#000000"
  };
  function getColor(overrides) {
    overrides = overrides || {};
    return LAYER_IDS.reduce(function(color, id) {
      color[id] = overrides[id] || DEFAULTS[id];
      return color;
    }, {});
  }
  function getStyleElement(element, prefix, side, color) {
    return element("style", {}, [
      LAYER_IDS.map(function(id) {
        var selector = "." + prefix + id;
        var style = colorToCssString(color[id]);
        return selector + " {" + style + "}";
      }).join(`
`)
    ]);
  }
  function colorToCssString(color) {
    var parsedColor = colorString.get(color);
    if (!parsedColor)
      return "";
    var css = "color: ";
    var components = parsedColor.value.slice(0, 3);
    var alpha = parsedColor.value[3] != null ? parsedColor.value[3] : 1;
    if (parsedColor.model === "rgb") {
      css += colorString.to.hex(components).toLowerCase();
    } else {
      css += colorString.to[parsedColor.model](components).toLowerCase();
    }
    if (alpha !== 1) {
      css += "; opacity: " + alpha;
    }
    return css + ";";
  }
  module.exports = { getColor, getStyleElement };
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/parse-options.js
var require_parse_options = __commonJS((exports, module) => {
  var boardColor = require_board_color();
  var xid = require_xml_id();
  var xmlElementString = require_xml_element_string();
  module.exports = function parseOptions(input) {
    if (typeof input === "string") {
      input = { id: input };
    } else if (!input) {
      input = {};
    }
    return {
      id: xid.ensure(input.id),
      color: boardColor.getColor(input.color),
      attributes: input.attributes || {},
      useOutline: input.useOutline != null ? input.useOutline : true,
      createElement: input.createElement || xmlElementString
    };
  };
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/sort-layers.js
var require_sort_layers = __commonJS((exports, module) => {
  var wtg = require_whats_that_gerber();
  module.exports = function sortLayers(layers) {
    return layers.filter(acceptLayer).reduce(assignLayer, {
      top: [],
      bottom: [],
      drills: [],
      outline: null
    });
  };
  function acceptLayer(layer) {
    return layer != null && layer.type != null && layer.side != null && layer.converter != null && layer.converter.layer != null && layer.converter.layer.length;
  }
  function assignLayer(result, layer) {
    var type = layer.type;
    var side = layer.side;
    if (type === wtg.TYPE_DRILL) {
      result.drills.push(layer);
    } else if (type === wtg.TYPE_OUTLINE) {
      result.outline = layer;
    } else {
      if (side === wtg.SIDE_TOP) {
        result.top.push(layer);
      } else if (side === wtg.SIDE_BOTTOM) {
        result.bottom.push(layer);
      }
    }
    return result;
  }
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/wrap-layer.js
var require_wrap_layer = __commonJS((exports, module) => {
  module.exports = function wrapLayer(element, id, converter, scale, tag) {
    var layer = converter.layer;
    var attr = { id };
    if (scale && scale !== 1) {
      attr.transform = "scale(" + scale + "," + scale + ")";
    }
    return element(tag || "g", attr, layer);
  };
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/_gather-layers.js
var require__gather_layers = __commonJS((exports, module) => {
  var viewbox = require_viewbox();
  var wtg = require_whats_that_gerber();
  var wrapLayer = require_wrap_layer();
  module.exports = function gatherLayers(element, idPrefix, layers, drills, outline, useOutline) {
    var defs = [];
    var layerIds = [];
    var drillIds = [];
    var units = "";
    var unitsCount = { in: 0, mm: 0 };
    var allLayers = layers.concat(drills, outline || []);
    var drillCount = 0;
    var getUniqueId = function(type) {
      var id = idPrefix + type;
      if (type === wtg.TYPE_DRILL) {
        drillCount++;
        id += drillCount;
      }
      return id;
    };
    allLayers.forEach(function(layer) {
      if (!layer.externalId) {
        defs = defs.concat(layer.converter.defs);
      }
      if (layer.converter.units === "mm") {
        unitsCount.mm++;
      } else {
        unitsCount.in++;
      }
    });
    if (unitsCount.in + unitsCount.mm) {
      units = unitsCount.in > unitsCount.mm ? "in" : "mm";
    }
    var viewboxLayers = useOutline && outline ? [outline] : allLayers;
    var box = viewboxLayers.reduce(function(result, layer) {
      var layerBox = layer.converter.viewBox;
      var layerUnits = layer.converter.units;
      if (layerUnits && layerBox[2] !== 0 && layerBox[3] !== 0) {
        return viewbox.add(result, viewbox.scale(layerBox, getScale(units, layerUnits)));
      }
      return result;
    }, viewbox.create());
    var wrapConverterLayer = function(collection) {
      return function(layer) {
        var id = layer.externalId;
        var converter = layer.converter;
        if (!id) {
          id = getUniqueId(layer.type);
          defs.push(wrapLayer(element, id, converter, getScale(units, converter.units)));
        }
        collection.push({ type: layer.type, id });
      };
    };
    layers.forEach(wrapConverterLayer(layerIds));
    drills.forEach(wrapConverterLayer(drillIds));
    var outlineId;
    if (outline) {
      if (outline.externalId && !useOutline) {
        outlineId = outline.externalId;
      } else {
        outlineId = getUniqueId(outline.type);
        defs.push(wrapLayer(element, outlineId, outline.converter, getScale(units, outline.converter.units), useOutline ? "clipPath" : "g"));
      }
    }
    return {
      defs,
      box,
      units,
      layerIds,
      drillIds,
      outlineId
    };
  };
  function getScale(units, layerUnits) {
    var scale = units === "in" ? 1 / 25.4 : 25.4;
    var result = units === layerUnits ? 1 : scale;
    return result;
  }
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/lib/stack-layers.js
var require_stack_layers = __commonJS((exports, module) => {
  var viewbox = require_viewbox();
  var wtg = require_whats_that_gerber();
  var gatherLayers = require__gather_layers();
  module.exports = function(element, id, side, layers, drills, outline, useOutline) {
    var classPrefix = id + "_";
    var idPrefix = id + "_" + side + "_";
    var mechMaskId = idPrefix + "mech-mask";
    var layerProps = gatherLayers(element, idPrefix, layers, drills, outline, useOutline);
    var defs = layerProps.defs;
    var box = layerProps.box;
    var units = layerProps.units;
    layers = layerProps.layerIds;
    drills = layerProps.drillIds;
    defs.push(mechMask(element, mechMaskId, box, drills));
    var layer = [createRect(element, box, "currentColor", classPrefix + "fr4")];
    var cuLayerId = findLayerId(layers, wtg.TYPE_COPPER);
    var smLayerId = findLayerId(layers, wtg.TYPE_SOLDERMASK);
    var ssLayerId = findLayerId(layers, wtg.TYPE_SILKSCREEN);
    var spLayerId = findLayerId(layers, wtg.TYPE_SOLDERPASTE);
    var outLayerId = layerProps.outlineId;
    if (cuLayerId) {
      var cfMaskId = idPrefix + "cf-mask";
      var cfMaskShape = smLayerId ? [useLayer(element, smLayerId)] : [createRect(element, box)];
      var cfMaskGroupAttr = { fill: "#fff", stroke: "#fff" };
      var cfMaskGroup = [element("g", cfMaskGroupAttr, cfMaskShape)];
      defs.push(element("mask", { id: cfMaskId }, cfMaskGroup));
      layer.push(useLayer(element, cuLayerId, classPrefix + "cu"));
      layer.push(useLayer(element, cuLayerId, classPrefix + "cf", cfMaskId));
    }
    if (smLayerId) {
      var smMaskId = idPrefix + "sm-mask";
      var smMaskShape = [
        createRect(element, box, "#fff"),
        useLayer(element, smLayerId)
      ];
      var smMaskGroupAtrr = { fill: "#000", stroke: "#000" };
      var smMaskGroup = [element("g", smMaskGroupAtrr, smMaskShape)];
      defs.push(element("mask", { id: smMaskId }, smMaskGroup));
      var smGroupAttr = { mask: "url(#" + smMaskId + ")" };
      var smGroupShape = [
        createRect(element, box, "currentColor", classPrefix + "sm")
      ];
      if (ssLayerId) {
        smGroupShape.push(useLayer(element, ssLayerId, classPrefix + "ss"));
      }
      layer.push(element("g", smGroupAttr, smGroupShape));
    }
    if (spLayerId) {
      layer.push(useLayer(element, spLayerId, classPrefix + "sp"));
    }
    if (outLayerId && !useOutline) {
      layer.push(useLayer(element, outLayerId, classPrefix + "out"));
    }
    return {
      defs,
      layer,
      mechMaskId,
      outClipId: outLayerId && useOutline ? outLayerId : null,
      box,
      units
    };
  };
  function findLayerId(layers, type) {
    var layer;
    var i2;
    for (i2 = 0;i2 < layers.length; i2++) {
      layer = layers[i2];
      if (layer.type === type) {
        return layer.id;
      }
    }
  }
  function useLayer(element, id, className, mask) {
    var attr = { "xlink:href": "#" + id };
    if (className) {
      attr.fill = "currentColor";
      attr.stroke = "currentColor";
      attr.class = className;
    }
    if (mask) {
      attr.mask = "url(#" + mask + ")";
    }
    return element("use", attr);
  }
  function createRect(element, box, fill, className) {
    var attr = viewbox.rect(box);
    if (fill) {
      attr.fill = fill;
    }
    if (className) {
      attr.class = className;
    }
    return element("rect", attr);
  }
  function mechMask(element, id, box, drills) {
    var children = drills.map(function(layer) {
      return useLayer(element, layer.id);
    });
    children.unshift(createRect(element, box, "#fff"));
    var groupAttr = { fill: "#000", stroke: "#000" };
    var group = [element("g", groupAttr, children)];
    return element("mask", { id }, group);
  }
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup-core/index.js
var require_pcb_stackup_core = __commonJS((exports, module) => {
  var extend = require_immutable();
  var wtg = require_whats_that_gerber();
  var vb = require_viewbox();
  var boardColor = require_board_color();
  var parseOptions = require_parse_options();
  var sortLayers = require_sort_layers();
  var stackLayers = require_stack_layers();
  var SIDES = [wtg.SIDE_TOP, wtg.SIDE_BOTTOM];
  var BASE_ATTRIBUTES = {
    version: "1.1",
    xmlns: "http://www.w3.org/2000/svg",
    "xmlns:xlink": "http://www.w3.org/1999/xlink",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": 0,
    "fill-rule": "evenodd",
    "clip-rule": "evenodd"
  };
  module.exports = function pcbStackupCore(layers, inputOpts) {
    var options = parseOptions(inputOpts);
    var sorted = sortLayers(layers);
    var id = options.id;
    var color = options.color;
    var attributes = options.attributes;
    var useOutline = options.useOutline;
    var element = options.createElement;
    var stacks = SIDES.map(function(side) {
      return stackLayers(element, id, side, sorted[side], sorted.drills, sorted.outline, useOutline);
    });
    var box = stacks.reduce(function(result, stack) {
      return vb.add(result, stack.box);
    }, vb.create());
    if (box.length !== 4)
      box = [0, 0, 0, 0];
    return stacks.reduce(function(result, stack, index) {
      var side = SIDES[index];
      var style = boardColor.getStyleElement(element, id + "_", side, color);
      var units = stack.units;
      var mechMaskId = stack.mechMaskId;
      var outClipId = stack.outClipId;
      var defs = [style].concat(stack.defs);
      var layer = [
        element("g", getGroupAttributes(box, side, mechMaskId, outClipId), stack.layer)
      ];
      var defsNode = element("defs", {}, defs);
      var layerNode = element("g", getLayerAttributes(box), layer);
      var sideAttributes = extend(BASE_ATTRIBUTES, {
        id: id + "_" + side,
        viewBox: vb.asString(box),
        width: box[2] / 1000 + units,
        height: box[3] / 1000 + units
      }, attributes);
      result[side] = {
        svg: element("svg", sideAttributes, [defsNode, layerNode]),
        attributes: sideAttributes,
        defs,
        layer,
        viewBox: box,
        width: box[2] / 1000,
        height: box[3] / 1000,
        units
      };
      return result;
    }, options);
  };
  function getGroupAttributes(box, side, mechMaskId, outClipId) {
    var attr = { mask: "url(#" + mechMaskId + ")" };
    if (outClipId) {
      attr["clip-path"] = "url(#" + outClipId + ")";
    }
    if (side === wtg.SIDE_BOTTOM) {
      var xTranslation = 2 * box[0] + box[2];
      attr.transform = "translate(" + xTranslation + ",0) scale(-1,1)";
    }
    return attr;
  }
  function getLayerAttributes(box) {
    var yTranslation = 2 * box[1] + box[3];
    return { transform: "translate(0," + yTranslation + ") scale(1,-1)" };
  }
});

// ../../../../Development/anvil/anvild/node_modules/pcb-stackup/index.js
var require_pcb_stackup = __commonJS((exports, module) => {
  var extend = require_immutable();
  var runParallel = require_run_parallel();
  var runWaterfall = require_run_waterfall();
  var gerberToSvg = require_gerber_to_svg();
  var createStackup = require_pcb_stackup_core();
  var wtg = require_whats_that_gerber();
  module.exports = function pcbStackup(layers, options, done) {
    var result;
    if (typeof options === "function") {
      done = options;
      options = null;
    }
    validateLayersInput(layers);
    if (done == null) {
      if (typeof Promise !== "function") {
        throw new Error("No callback specified and global Promise not found");
      }
      result = new Promise(function(resolve, reject) {
        done = function callbackToPromise(error, stackup) {
          if (error)
            return reject(error);
          resolve(stackup);
        };
      });
    }
    var layerTypes = wtg(layers.map(function(layer) {
      return layer.filename;
    }).filter(Boolean));
    runWaterfall([
      function renderAllLayers(next) {
        var layerTasks = layers.map(makeRenderLayerTask);
        runParallel(layerTasks, next);
      },
      function renderStackup(stackupLayers, next) {
        var stackup = createStackup(stackupLayers, options);
        stackup.layers = stackupLayers;
        next(null, stackup);
      }
    ], function finish(error, stackup) {
      if (error)
        return done(error);
      done(null, stackup);
    });
    return result;
    function makeRenderLayerTask(layer) {
      return function renderLayer(next) {
        var stackupLayer = makeBaseStackupLayer(layer);
        if (stackupLayer.converter)
          return next(null, stackupLayer);
        var converter = gerberToSvg(stackupLayer.gerber, stackupLayer.options, function handleLayerDone(error) {
          if (error)
            return next(error);
          stackupLayer.converter = converter;
          next(null, stackupLayer);
        });
      };
    }
    function makeBaseStackupLayer(layer) {
      var layerSide = layer.side;
      var layerType = layer.type;
      if (layer.filename && typeof layerSide === "undefined" && typeof layerType === "undefined") {
        var gerberId = layerTypes[layer.filename];
        layerSide = gerberId.side;
        layerType = gerberId.type;
      }
      var layerOptions = extend(layer.options);
      if (layerOptions.plotAsOutline == null && layerType === wtg.TYPE_OUTLINE) {
        layerOptions.plotAsOutline = true;
      }
      if (options && options.outlineGapFill != null && layerOptions.plotAsOutline) {
        layerOptions.plotAsOutline = options.outlineGapFill;
      }
      return extend(layer, {
        side: layerSide,
        type: layerType,
        options: layerOptions
      });
    }
  };
  function validateLayersInput(layers) {
    if (!Array.isArray(layers)) {
      throw new Error("first argument should be an array of layers");
    }
    var layerErrors = layers.map(getLayerValidationError).filter(Boolean).join(", ");
    if (layerErrors)
      throw new Error(layerErrors);
  }
  function getLayerValidationError(layer, index) {
    var result = wtg.validate(layer);
    var error = null;
    if (!layer.converter && !layer.gerber) {
      error = "is missing gerber source or cached converter";
    } else if (!layer.filename && !layer.type) {
      error = "is missing filename or side/type";
    } else if (!layer.filename && !result.valid) {
      error = "has invalid side/type (" + layer.side + "/" + layer.type + ")";
    }
    return error ? "layer " + index + " " + error : null;
  }
});

// web/src/vendor/_tracespace-entry.ts
var import_pcb_stackup = __toESM(require_pcb_stackup(), 1);
var import_gerber_to_svg = __toESM(require_gerber_to_svg(), 1);
var export_pcbStackup = import_pcb_stackup.default;
var export_gerberToSvg = import_gerber_to_svg.default;

export {
  export_pcbStackup as pcbStackup,
  export_gerberToSvg as gerberToSvg
};
