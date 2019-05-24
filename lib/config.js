const proxyOptions = {
  noPreserveState: false,
};

export const configure = options => {
  Object.assign(proxyOptions, options);
};

export const getConfig = () => proxyOptions;
