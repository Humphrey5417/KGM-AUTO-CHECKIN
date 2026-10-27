// 手机验证码发送
module.exports = (params, useAxios) => {
  const dataMap = {
    businessid: 5,
    mobile: `${params?.mobile}`,
    plat: 3,
  };

  return useAxios({
    // 注意：不要直连 http://login.user.kugou.com —— 其 IPv4 边缘节点会对无 IPv6 出口的环境
    // （典型如 Docker 容器）直接回空包 500 拒绝；统一走 gateway.kugou.com 网关 + x-router
    // 路由（与签到模块同款路径，容器/本地均稳定可达）。
    url: '/v7/send_mobile_code',
    method: 'POST',
    data: dataMap,
    encryptType: 'android',
    headers: { 'x-router': 'loginservice.kugou.com' },
    // createRequest 读取的是 cookie.KUGOU_API_MID（键名必须一致，否则外发 mid 为 "undefined"）。
    // 只传设备标识、不透传 token/userid，保持登录请求的匿名性。
    cookie: { KUGOU_API_MID: params?.cookie?.KUGOU_API_MID },
  });
};
