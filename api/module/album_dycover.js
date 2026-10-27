// 专辑动态封面
// 参考反编译 com.kugou.android.common.utils.AlbumInfoProtocol + hd1/e.java
// 注意：
// - data 参数需先 JSON.stringify 再 URL 编码后放入查询串
// - 该 CDN 固定使用标准版(手机版)的盐值/appid/clientver，与 process.env.platform 无关
const { cryptoMd5 } = require('../util');
const { appid, clientver } = require('../util/config.json');

// 标准版(手机版)签名盐值，来自 KugouPlayer/com.kugou.common.network.Utils/ParamGenerator
const STANDARD_SALT = 'OIlwieks28dk2k092lksi2UIkp';

// MD5(盐值 + 按key排序后的k=v拼接串 + 盐值)
const signatureStandardParams = (params) => {
  const paramsString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('');
  return cryptoMd5(`${STANDARD_SALT}${paramsString}${STANDARD_SALT}`);
};

module.exports = (params, useAxios) => {
  const data = (params?.album_audio_id || '').split(',').map((s, index) => {
    const album_id = Number((params?.album_id || '').split(',')[index]) || 0;
    const obj = { album_audio_id: Number(s) };
    if (album_id > 0) {
      obj['album_id'] = album_id;
    }
    return obj;
  });

  const paramsMap = {
    appid,
    clientver,
    data,
    isCdn: 1,
    query: params?.query || 'audioPlay',
  };

  const query = Object.keys(paramsMap)
    .sort()
    .map((s) => `${s}=${encodeURIComponent(typeof paramsMap[s] === 'object' ? JSON.stringify(paramsMap[s]) : paramsMap[s])}`);

  const signature = signatureStandardParams(paramsMap);

  return useAxios({
    baseURL: 'https://kmrcdn.service.kugou.com',
    url: `/v2/album/audio?${query.join('&')}`,
    method: 'GET',
    encryptType: 'android',
    params: { signature },
    cookie: params?.cookie || {},
    notSign: true,
    clearDefaultParams: true,
    // 该 CDN 对头很敏感：带默认的 kg-* 系列头且缺 clienttime 会随机触发 sign error，
    // 因此只显式发送 dfid/mid/clienttime 三个身份头（其余默认头全部清除）
    clearDefaultHeaders: true,
    headers: {
      dfid: '-',
      mid: 'undefined',
      clienttime: Math.floor(Date.now() / 1000),
    },
    skipProxy: true,
  });
};