# egern-dns-health

Egern iOS 端的 DoH 上游健康检查脚本。跑在 Egern 内置 JavaScript 沙箱里，不依赖 VPS。

每跑一次会并发 probe 10 个公共 DoH 端点 → 按延迟排序 → 把"赢家"和"全挂掉的"通过
`ctx.notify` 推系统通知 → 结果写 `ctx.storage` 持久化。脚本本身无副作用，可随时删。

## 添加到 Egern

**Profiles → 当前 profile → scriptings**，加下面这段（`script_url` 用 jsDelivr CDN）：

```yaml
scriptings:
  - schedule:
      name: doh-health
      cron: "0 */1 * * *"          # 每小时一次；想 5 分钟一次改成 "*/5 * * * *"
      script_url: https://cdn.jsdelivr.net/gh/bluee1111/egern-dns-health@v1.0.0
      timeout: 30
      update_interval: 86400
  - network:
      name: doh-health-on-change
      script_url: https://cdn.jsdelivr.net/gh/bluee1111/egern-dns-health@v1.0.0
      timeout: 30
      update_interval: 86400
  - generic:
      name: doh-health-now           # 工具菜单里会出现 "doh-health-now"，手动跑一次
      script_url: https://cdn.jsdelivr.net/gh/bluee1111/egern-dns-health@v1.0.0
      timeout: 30
      update_interval: 86400
```

> jsDelivr 缓存：`<gh_user>/<repo>@<tag>/<file>` 这种路径会按 tag 缓存。tag 推了之后
> 想换 latest，把上面三处 `@v1.0.0` 改成 `@latest` 即可（不锁版本）。

## 跑完后会看到

一个系统通知，标题是 `DoH best: <name> <ms>ms`，正文按延迟列 ok + fail，最稳的一个
会附 `action: clipboard`（长按通知可一键复制 URL）。然后把那个 URL 填到 Egern 的
`dns-server` 即可。

## 默认 upstream

| name          | url                                       |
|---------------|-------------------------------------------|
| ali-resolve   | `https://dns.alidns.com/resolve`          |
| ali-wire      | `https://dns.alidns.com/dns-query`        |
| doh.pub       | `https://doh.pub/dns-query`               |
| 360           | `https://dns.360.cn/dns-query`            |
| cf-1.1.1.1    | `https://1.1.1.1/dns-query`               |
| cf-1.0.0.1    | `https://1.0.0.1/dns-query`               |
| google        | `https://dns.google/dns-query`            |
| quad9         | `https://dns.quad9.net/dns-query`         |
| adguard       | `https://dns.adguard-dns.com/dns-query`   |
| mullvad       | `https://adblock.mullvad-dns.net/dns-query` |

`ali-resolve` 走 GET + JSON params（GET-friendly 入口），其它 `-dns-query` 端点走
POST RFC8484 wireformat（这是 Egern 上游配 `https://.../dns-query` 时实际跑的协议）。
两类都通才算健康。

## Egern script API

本脚本只用三个 API：

- `ctx.http.get / post(url, opts)` — `policy: 'direct'` 强制直连 probe，避免污染
- `ctx.storage.setJSON / getJSON(key)` — 持久化最近的 winner
- `ctx.notify({ title, body, sound, action })` — 系统通知 + `clipboard` action

完整 API 见 [Egern JavaScript API Reference](https://egernapp.com/docs/javascript-api/)。

## 相关项目

- [bluee1111/egern-douyin](https://github.com/bluee1111/egern-douyin) — 抖音直连规则集
- [bluee1111/egern-cmcc-direct](https://github.com/bluee1111/egern-cmcc-direct) — 移动云盘直连规则集
