const proxyOptions = {
  noPreserveState: false,
  // enable/disable native support
  native: false,
};

const observers = [];

export const configure = options => {
  Object.assign(proxyOptions, options);
  observers.forEach(fn => fn(proxyOptions));
};

export const getConfig = () => proxyOptions;

export const isNative = () => !!proxyOptions.native;

export const observeConfig = observer => {
  observers.push(observer);
};
