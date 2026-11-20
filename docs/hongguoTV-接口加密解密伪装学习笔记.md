# hongguoTV 接口加密 / 解密 / 伪装学习笔记

> 定位：对公开仓库 `N3urda/hongguoTV`（GPL-3.0）主线 `kotlin-tv/` 源码的**结构性解读**，目的是理解一套非官方客户端如何与它所选定的服务端通信。文中只讨论算法结构、工程取舍与源码位置，不提供可直接运行的服务端攻击、绕过付费或批量访问能力。
>
> 学习边界：这些接口由平台控制，随时变更；仓库自身声明与平台无授权关系。请把本文当作协议分析与逆向工程的**案例研究**材料，遵守适用法律与平台条款。
>
> 源码基线：仓库 `main` 分支（2026-11-16），`kotlin-tv/core` 与 `kotlin-tv/app` 两个模块。下文文件路径均相对于 `kotlin-tv/`。

---

## 0. 先看全景：三道防线与三层对应

理解这个项目，关键是把它面对的防护拆成三层，客户端每一层都有对应实现：

| 防护层 | 平台做什么 | 客户端对应代码 |
|---|---|---|
| ① 请求合法性 | 校验一组私有签名头 + 时间参数 | `core/Signer.kt`、`core/Argus.kt`、`core/AesV3.kt` |
| ② 设备合法性 | 只放服务端注册过的 `device_id` / `install_id` | `core/DeviceRegister.kt`、`core/DeviceRegistrar.kt` |
| ③ 内容与凭据保护 | 视频流加密、登录态需保密 | `core/MediaCrypto.kt`、`app/AccountCipher.kt` |

一个容易混淆的事实：**第 ① 层的"签名"并不是传统意义的"加密数据"**。它不隐藏请求内容，而是用一组只有客户端能算出的头证明"这是一台像官方 App 的设备发出的请求"。真正做字节级加解密的是 `AesV3`（签名内部）、`Argus`（Simon + AES）、`MediaCrypto`（视频 CTR）和 `AccountCipher`（Keystore GCM）。

阅读顺序建议：先看 §1 的签名头家族建立地图 → §2 学"签名是怎么算的" → §3 学"密文是怎么解开的" → §4 学"身份是怎么伪装的" → §5 用思考题检验理解。

---

## 1. 签名头家族：一张地图

任何一次 `Signer.sign()` 调用产出的请求头集合大致如下（源码：`core/Signer.kt:458-514`）：

| 头 | 含义 | 在 Signer.kt 中的生成方式 |
|---|---|---|
| `x-khronos` | 秒级时间戳 | `ts.toString()` |
| `x-ladon` | 时间戳签名 | `be32(ts).base64()`（简版）或 `Ladon.encrypt()`（完整 ARX，见 `Argus.kt`） |
| `x-argus` | 请求体/环境签名 | `le32(ts).base64()`（简版）或 `Argus.sign()` |
| `x-gorgon` | 查询串签名 | `gorgon(query, body, ts, random)`，RC4 风格置换 |
| `x-helios` | 时间戳签名 | `helios(ts)`，34 轮 ARX |
| `x-medusa` | 设备环境签名 | `medusa(url, body, ts, identity)`，最复杂的一层 |
| `x-ss-stub` | 请求体指纹 | `MD5(body).hex().uppercase()` |
| `x-ss-req-ticket` | 毫秒票据 | `now + offset`，`offset` 由 branch 搜索决定 |

关键观察：**同一个头在不同实现文件里有两套算法**。`Signer.kt` 用简版（如 `x-ladon = be32(ts).base64()`），`Argus.kt` 的 `PlayerSigner.headers()` 用完整版（`Ladon.encrypt` 与 `Argus.sign`）。这是历史分层：前者服务目录/搜索接口，后者服务播放器接口（`core/Argus.kt:359-380`）。源码注释明确记录，2026-11-06 的复测显示简版头形态 `0/12` 被拒，服务端要求完整官方形态——这提示读者：**签名是与服务端版本强绑定的协议，不是通用算法**。

请求最终形态见 `Signer.sign()`：拼接 `base?query`，写入头集合，`body` 为 JSON 字节。真正的网络发送在 `ContentRepository` 中，例如 `core/ContentRepository.kt:669` 的搜索、`:730` 的详情、`:1380` 的播放模型。

---

## 2. 加密：签名是怎么算出来的

### 2.1 先解决"分支选择"问题（理解全项目的钥匙）

`Signer` 只实现了哈希的一个分支（文件头注释：`Only hash branch 0 is emitted`）。服务端却会根据请求参数把哈希分到不同分支。解决办法不是实现全部分支，而是**调整请求参数，让服务端落到已实现的那个分支**：

```kotlin
// core/Signer.kt:466-472
var ticket = now
for (offset in 0..127) {
    ticket = now + offset
    query = encode(values + mapOf("ts" to ts.toString(), "_rticket" to ticket.toString()))
    if (branch(query, body, ts) == 0) { ... break }
}
```

逻辑：

1. `branch()`（`:89-91`）计算 `iv = getIv(getIv(getIv(0x20230928, sm3(query)), md5(body)), le32(ts))`，取低 4 位；v3 下 `%3`，要求结果为 `0`；v5 下要求结果恰为 `12`。
2. `_rticket` 是 query 的一部分，改变它就会改变 `sm3(query)`，进而改变分支。
3. 枚举 `offset` 直到命中目标分支。v5 播放接口把搜索上界放宽到 `1024`（`signPlayback`，`:526`），并固定不加 `ts` 参数。

这是全书最重要的一个"逆向工程式"技巧：**当协议分支由自身参数决定时，用参数搜索把状态空间折叠到已实现分支**，而不是穷举所有分支的密码学实现。

### 2.2 `hashF13`：一个协议特定的哈希函数

`hashF13(query, body, ts)`（`Signer.kt:105-175`）产出一个校验值，被塞进 `medusa` 消息的字段 13。它的结构很像 MD5/SIMD 风格的自定义压缩函数：

1. **分支索引**：`index = (iv & 15) / 3`（v3），据此从 6 个 `ivV1` 常量、6 个 `chosen` 轮选择数组中选一组；v5 固定种子 `0x9d4a97c2` 与选位 `(1,3,4,0,6,5,2,0,7,7)`（见 `SIGNING_V5.md`）。
2. **消息填充**：`data = query + body + le32(ts) + pad + hex("00000000000001a0")`，其中 `pad` 由固定常量按 `(count+2)&7` 移位生成。
3. **消息扩展**：按 4 字节切分为 `di`，追加 112 个 word，每项由 `di[i]+di[i+9]` 与两个变量的三次循环左移/右移异或组合而成。
4. **状态混淆**：8 个初始状态字 `d` 先按 `count` 右旋，然后执行 `chosen[0]` 轮（96~101 轮）混合，每轮包含旋转、异或、与/或掩码、查表 `tt`（`VendorConstants.hashTable` 按 `count` 旋转）和加法。
5. **折叠输出**：把 `ret`（8 words = 32 字节）前后 16 字节异或折叠，再追加 `sumMd5(folded)` 校验位；v5 额外置 bit 5。

学习价值：它示范了"逆向出来的哈希"通常长什么样——常量魔数、位旋转、查表、轮函数、校验和，而非标准 SHA/MD5 的直接调用。

### 2.3 `medusa`：protobuf + 自定义置换 + 自定义分组加密

`medusa()`（`Signer.kt:288-371`）是 x-medusa 头的生成过程，链条最长：

1. **构造嵌套 protobuf**：`deviceProto()`（`:213-251`）把设备指纹、进程 nonce、进程启动时间、时区/语言、机型等编成 38 个字段；`env` 再嵌入版本、嵌套设备等；`message` 嵌入 magic `f7e85ffad7d7dc3bd62ac87057cf6118`、`aid=8662`、`device_id`、`ts`、`hashF13` 结果、`querySm3` 前 6 字节、环境 JSON 等。
2. **派生密钥与种子**：`hash = sm3(signKey + le32(r) + signKey)`，`seed` 由 `r` 的位运算取反得到。
3. **`xmxor()` 自定义流置换**（`:253-286`）：对消息逐字节做半字节交换、加法、取反、循环移位，然后**反转整个序列**，再逐轮用相邻字节与前序累积量改写；末尾用 XOR 链和求和收尾。这是典型"混淆 + 扩散"的手工实现。
4. **打包**：`packed = 0x35 + le32(rand) + le32(check) + transformed + 2 字节尾部索引`，`check` 由 `querySm3[0]` 与 `queryBodyTs[0]` 各取 6 位拼成。
5. **`AesV3` 加密**（下一步详述），最后拼上版本前缀与随机数字节，`base64` 输出。

v5 变体 `medusaV5()`（`:373-412`）改用 `V5Constants.magic/license/signKey/sbox`，头标识字节从 `0x35` 变为 `0xca`，路径整体同构。

### 2.4 `AesV3`：不是标准 AES

文件首行明说：`Protocol-specific transform, not standard AES`（`core/AesV3.kt:1`）。理解它的结构是本节难点：

- **时限参数化**：`word = timestamp and 3`，据此从 1024 字节的 `sbox`（`VendorConstants.sbox`）里取 256 字节片段，并选 `con`（列置换）、`order`（字节位置置换）、`initial`（初始状态常量）。**同一份输入在不同时间戳下走不同的 S-box 和置换表**，这是抗重放的关键设计。
- **密钥扩展**（`:31-66`）：`initial` 重复 4 次拼 `le32` 后与 `key` 异或，再补 32 字节零，8 轮扩展成 12 个 round key；每 4 轮做一次 S-box 代换。
- **`block()` 分组变换**（`:68-99`）：4×4 状态矩阵 → `addRoundKey` → 2 轮（S-box 代换 → 按 `con` 重排行 → 按 `order` 重排字节 → 类 MixColumns 的 xt 变换）→ 末轮 `addRoundKey`。
- **`encrypt()` 的位打包**（`:101-120`）：不是按字节而是按 bit——把每 8 个源字节的第 `wire[j]` 位抽出来，压进 31 字节的 `plaintext`；第 32 字节置 `1`；再做 CBC 风格两次 `block()`；最后把结果 key 的 bit 按 `compact[j]` 写回源字节。输出是 `key.last() + out`。

学习要点：把 `AesV3` 当作"借用了 AES 术语的定制分组密码"来读，不要套用标准 AES 的轮数/密钥长度直觉。`require(source.size >= 248)` 说明它被设计为加密一个足够大的 protobuf 块。

### 2.5 `x-argus`：Simon 分组密码 + 551 帧结构

`core/Argus.kt` 提供了另一套签名体系，来自 `fqapp`（见文件头致谢）：

- **`ProtoBuf`**（`:12-39`）：只写不读的 protobuf 编码器，varint 截断到 32 位。
- **`Simon`**（`:42-81`）：64 位分组 / 128 位密钥 / 72 轮的轻量分组密码，`Z = 0x3DC94C3A046D678B` 为常量；`decrypt()` 是加密的逆，用于离线验证。
- **`Argus.sign()`**（`:116-156`）：构造 `ArgusBean551`（含 aid、device_id、version_name、`ts<<1`、bodyHash、queryHash、子消息 23 等）→ PKCS7 对齐 → Simon 逐块加密 → 拼 `MAGIC8 + enc + TAIL9` → 对第 8 字节起异或 `MAGIC8[i%8]` → 整体反转 → 追加 `"ao"` → PKCS7 → AES-CBC（`AES_KEY` / `AES_IV`）→ 前加 `0xf2 0x81` → base64。

```text
protobuf bean ──PKCS7──> Simon(72轮) ──> MAGIC8 + ct + TAIL9
     ──xor MAGIC8──> reverse ──+ "ao"──> PKCS7 ──> AES-CBC ──> 0xf2 0x81 + base64
```

- **`decrypt551()`**（`:183-207`）完整实现了逆过程，`recover551Field3()`（`:210-246`）甚至能从签名中反解出 bean 的随机数字段。这是很好的教学材料：**能解密自己生成的签名，说明签名格式是可逆容器而非单向哈希**——安全性来自密钥保密和服务端校验，而非格式不可逆。

### 2.6 `x-ladon` 与 `x-helios`：两种 ARX

- **`Ladon.encrypt()`**（`Argus.kt:251-262`）：34 轮 ARX 分组密码，轮函数 `b = k XOR (a + ror(b,8))`、`a = b XOR rol(a,3)`；密钥表由 `md5(random + aid)` 的十六进制扩展而来；加密 `"khronos-lcId-aid"` 字符串。
- **`helios()`**（`Signer.kt:414-444`）：同样 34 轮 ARX，但轮函数写成 `b = table[i] XOR (a + ror(b,8))`、`a = b XOR rol(a,61)`，表由 `md5(le32(random) + "8662")` 扩展；加密 `"ts-license-8662"`。

对比阅读这两个函数，可以看出同一类 ARX 设计在两处实现中的参数差异（`rol 3` vs `ror 61`、`+i` 的位置、表的来源），这是学习"协议族相似性"的好例子。

---

## 3. 解密：密文是怎么被客户端还原的

### 3.1 登录凭据：Android Keystore + AES-GCM

源码：`app/AccountController.kt:32-103`（`AccountStore`）与 `app/AccountCipher.kt`。

- **Android 6+（API ≥ 23）**：用 `KeyGenParameterSpec` 在 `AndroidKeyStore` 中生成 AES 密钥，指定 `BLOCK_MODE_GCM` + `PADDING_NONE`。密钥**不可导出**，Keystore 自行产生 IV。
- **Android 5（API < 23）**：`Keystore` 不支持 GCM AES，改为生成 RSA 密钥对，用公钥包装一个随机的 256 位 AES 密钥，把密文存进 `wrapped_key`。磁盘上不出现明文 AES 密钥。
- **密文格式**：`IV(12B) + 密文+GCM tag`（`AccountCipher.kt:12-23`）。解密时先按 12 字节 IV 尝试；失败且是 legacy 时按 16 字节 IV 重试（`:25-37`）。
- **一条值得记住的安全原则**：源码注释明确写 `Authentication still has to succeed; never accept unauthenticated plaintext`（`:34`）——兼容旧格式时**不降级到无认证解密**。这是凭据存储类代码的关键纪律。

登录态 JSON 存于 `SharedPreferences("cloud_account_secure")` 的 `session` 键，账号记录与本机观看记录分文件保存。

### 3.2 内容密钥派生：`MediaCrypto.deriveKey`

`core/MediaCrypto.kt:17-34`：

1. base64 解码，用 `raw[0]^raw[1]^raw[2]` 参与计算有效长度（一种隐藏长度的混淆）。
2. 逐字节变换：`work[i] = (-21 - bitCount(i) + (previous XOR old))`，其中 `previous` 奇偶位交替取 `a`/`b`。
3. 取 `work[1..32]` 当作 ASCII 十六进制文本，再 `hex()` 解码成 16 字节 AES 密钥。

这是"密钥不直接传输，而是藏在一段经过混淆的编码串里"的典型模式。

### 3.3 视频 URL 解密：`decryptUrl`

`MediaCrypto.kt:36-56`：校验 `0xa8` 前缀和固定标志字节 → `h = SHA512(SHA512(seed) + 常量)` → 用 `h[0:16]` 作 key、`h[16:32]` 作 IV，AES-CBC 解密 → 去 PKCS7 与尾部 `0` → UTF-8 得到 URL。

值得注意：`DeviceRegister.KDF_SALT`（`DeviceRegister.kt:54-57`）与这里的 `constants` 是**同一串常量**，设备注册加密与内容 URL 解密共享同一个 KDF 材料。跨域复用常量是这个项目的一个结构性特点。

### 3.4 视频流解密：ISO BMFF 解析 + AES-CTR

这是全项目最"正统"的密码学部分（`MediaCrypto.kt:82-282`），因为它直接用标准库：

1. **容器校验** `headerEnd()`（`:82-96`）：检查 `ftyp` 与前置 `moov`，确保索引在文件头且不超过 8 MB。
2. **索引解析** `prepare()`（`:98-231`）：遍历 `moov → trak → stbl`，读取：
   - `stsz`（样本大小）、`stsc`（块到样本的映射）、`stco`/`co64`（块偏移）；
   - `saiz`/`saio`（辅助信息大小与偏移），从中取 8 字节 IV（补零到 16）和可选的子样本表；
   - 每个子样本给出 `clear` 字节数与 `encrypted` 长度，用于部分加密（clear + protected 混合）的场景。
3. **还原编码标记**（`:206-225`）：从 `sinf/frma` 读出原始编码（AVC/HEVC），把 `encv`/`enca` 改回原标记，并把 `sinf` 置为 `free`。源码注释明确指出这个设计取舍：`Preserve the original codec from frma (AVC and HEVC), not a hardcoded HEVC tag`——早期 bug 正是硬编码 HEVC 导致 AVC 视频无法播放。
4. **CTR 解密** `decrypt()`（`:233-282`）：对每个 sample，计算 `counter = 8字节IV + (relative/16)` 的 128 位大整数，用 AES-CTR 解密对应区间；通过 `skip = relative % 16` 处理子样本起始不在块边界的情况；按请求区间 `[start, end)` 做二分查找定位 sample，支持边下载边解密（Range 请求场景）。

这个实现展示了 DRM-like 流媒体在客户端的通用解法：**解析容器索引定位加密样本 → 用 sample IV 构造 CTR counter → 对请求字节区间做流式解密**。

---

## 4. 伪装：身份与环境是怎么"扮演"的

### 4.1 静态设备指纹

`core/VendorConstants.kt:13-42` 的 `device` 字典是一整套虚构但自洽的官方客户端身份：`aid=8662`、`app_name=novelread`、`version_code=71332`、`device_type=25053RT47C`、`device_brand=Redmi`、`os_api=36`、`resolution=1280*2772` 等。三套 UA 分别对应不同场景（`:5-12`）：

- `APP_UA`：`com.phoenix.read/72232 (Linux; U; Android 16; ...)`
- `VIDEO_UA`：带 `Cronet/TTNetVersion` 串，用于视频类请求
- `PLAYER_UA`：伪装成 `com.phoenix.read/71532 ... SM-N9860 ... Android 9`，用于播放接口

**一致性是伪装的难点**：`Signer.deviceProto()` 里的 `device_id` 必须与 query 参数中的注册身份一致，源码注释明确服务端会核对（`Signer.kt:211-212`）。这也是 `sign()` 接受 `identity` 参数并透传给 `medusa()` 的原因——播放接口使用注册设备身份，而非静态占位身份。

### 4.2 设备注册：先"匿名"拿到合法身份

`core/DeviceRegister.kt` 的注释是这个项目最有价值的"经验文档"之一。核心结论（`:12-19`）：内容接口按注册过的设备放行；未注册设备搜索返回 `HTTP 200 + 0 字节`，播放返回 `101000`；注册是**匿名**的——不需要账号、密码或短信，请求里**连签名头都没有**。

请求构造（`:74-90`、`:102-178`）：

```text
body = ttEncrypt( gzip( JSON ) )
ttEncrypt(data) = MAGIC(6B) || rnd(32B) || AES-CBC(
    key/iv = SHA512( SHA512(rnd) + KDF_SALT )[0:16] / [16:32],
    plaintext = PKCS7( SHA512(data) || data )
)
```

JSON 里伪装成 `com.phoenix.read` / `aid=8662` / `display_name=红果免费短剧`，并记录三个实测踩坑：

1. body 必须是**原始二进制**，HAR 里的 base64 文本只是显示形式——发文本会得到 `device_id=0`。
2. `os_version` 必须是**字符串**，写成数字会被拒（实测字符串 6/6、数字 0/6）。
3. 不要手动设 `accept-encoding`，交给 OkHttp 透明解压；不要加 `x-gorgon` 等签名头，否则被判异常客户端（`:37-43`、`:197-200`）。

响应解析（`:212-241`）接受 `device_id` 为数字或字符串，全 `0` 视为拒绝，并回写 `Set-Cookie`。

### 4.3 头形态切换

`Signer.sign(playback = true)`（`:458-514`）与 `signPlayback()`（`:519-548`）体现"同一签名内核、不同头集合"：播放形态**不带** `x-tt-request-tag` / `passport-sdk-version` / `x-ss-stub`，改带 `x-tt-store-region=cn` / `x-tt-store-region-src=did`。`mobileV5=true` 时甚至只保留 `x-khronos` / `x-helios` / `x-medusa` 三个头（`:540`）。

这提示读者：伪装不是"头越多越像"，而是**不同端点要求不同的头组合**，需要通过抓包对照确定。

### 4.4 登录流程伪装

`core/WebLogin.kt` 用官网 `hongguoduanju.com` 完成扫码登录：

- 自建 `CookieJar` 手动管理 CSRF Cookie，关闭自动重定向（`:13-24`）；
- 每次请求带 `aid=513755`、`passport_jssdk_version=3.4.10`、`Referer`、`Origin`，并从 `passport_csrf_token` 提取 `x-tt-passport-csrf-token`（`:56-82`）；
- `qr()` 取二维码，`poll()` 轮询 `check_qrconnect`，`status=3/confirmed` 时走 `finishRedirect()`，且校验每一跳 host 白名单（`:140`、`:227`），最后从 `sessionid` 提取凭据。

手机验证码登录 `core/PhoneLogin.kt` 则指定 `security.snssdk.com`，注释记录了 `is.snssdk.com` 会触发风控码 2046 的实测结论（`:209-210`）。

### 4.5 多域名回退

`RecommendationFeed.kt:394-396`、`PlayRetry.kt:10-22`、`Probe.kt:808-814` 都维护 `api5-normal-sinfonlinea/b/c` + `hl` + `lf` 的域名列表。签名逻辑与域名无关，因此可实现"同一签名、换 host 重试"。这是对抗局部节点故障或封禁的工程手段，不属于密码学范畴，但对可用性至关重要。

---

## 5. 学习思考题（建议自己先答，再看源码验证）

1. 为什么 `sign()` 选择"搜索 ticket 使 branch=0"，而不是实现全部哈希分支？这种技巧的适用前提是什么？
2. `Argus.decrypt551()` 能把自己生成的签名解开。既然格式可逆，签名的安全性来自哪里？
3. `AccountCipher.decrypt()` 在 legacy 兼容分支里为什么坚持 GCM 认证必须成功，而不接受"解出来像 JSON 就用"？
4. 设备注册为什么**刻意不加签名头**？这说明"签名"在服务端的语义是什么？
5. `AesV3` 为什么按 `ts & 3` 切换 S-box 和置换表？如果固定不切换，会失去什么性质？
6. `MediaCrypto.prepare()` 为什么不硬编码 HEVC，而要从 `frma` 读原始编码？这个 bug 的根源是什么？
7. v3 签名与 v5 签名为什么在仓库中**同时保留**而不是替换？阅读 `SIGNING_V5.md` 后，说说"实测证据"与"测试通过"在这个项目里如何区分。

---

## 附录 A：源码索引（按学习顺序）

| 主题 | 文件 | 关键行 |
|---|---|---|
| 签名总入口、branch 搜索 | `core/Signer.kt` | 89-91, 458-548 |
| hashF13 | `core/Signer.kt` | 105-175 |
| gorgon / medusa / xmxor | `core/Signer.kt` | 177-209, 253-371 |
| helios / medusaV5 | `core/Signer.kt` | 373-444 |
| 自定义 AES | `core/AesV3.kt` | 全文 |
| Argus / Simon / Ladon | `core/Argus.kt` | 42-81, 84-247, 250-291 |
| 评论接口签名 | `core/CommentSignature.kt` | 63-218 |
| 设备注册与 ttEncrypt | `core/DeviceRegister.kt` | 45-204 |
| 设备再注册 | `core/DeviceRegistrar.kt` | 138-181 |
| 内容密钥与视频解密 | `core/MediaCrypto.kt` | 17-282 |
| 凭据加密 | `app/AccountCipher.kt`、`app/AccountController.kt` | 全文 / 32-103 |
| 设备指纹与 UA | `core/VendorConstants.kt` | 5-42 |
| v5 常量 | `core/V5Constants.kt` | 全文 |
| 字节工具（sm3/le32/aes/rol） | `core/Bytes.kt` | 全文 |
| 扫码登录 | `core/WebLogin.kt` | 13-234 |
| v5 设计说明 | `SIGNING_V5.md` | 全文 |

## 附录 B：术语速查

- **branch**：服务端根据请求参数选择的哈希分支；本项目只实现 branch 0（v3）/ branch 12（v5）。
- **ticket**：`_rticket` / `x-ss-req-ticket`，可微调的时间相关参数，用来控制 branch。
- **protobuf**：这里用来自定义"序列化格式"，不是标准 protobuf schema，字段号是逆向所得。
- **ARX**：Add-Rotate-XOR，一类只做加法、循环移位、异或的轮函数设计（`Ladon`、`helios`）。
- **Simon**：NSA 发布的轻量分组密码，本项目用其 64/128/72 轮参数。
- **AesV3**：项目内自定义分组变换，借用 AES 概念但**不是**标准 AES。
- **saiz/saio**：ISO BMFF 中描述加密辅助信息的 box，用于定位每个 sample 的 IV。
- **CTR 模式**：把 counter 加密后与明文异或；支持按字节区间随机解密，适合视频 Range 请求。
