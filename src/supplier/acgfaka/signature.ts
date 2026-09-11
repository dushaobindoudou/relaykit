/**
 * acg-faka 上游对接签名。
 *
 * 对拍目标是 PHP 端的 App\Util\Str::generateSignature：
 *
 *   unset($data['sign']);
 *   ksort($data);
 *   foreach ($data as $key => $val) { if ($val === '') unset($data[$key]); }
 *   return md5(urldecode(http_build_query($data) . "&key=" . (string)$appKey));
 *
 * 这四行里藏了五个会让签名静默算错的 PHP 语义，逐条在下面的实现里对应处理，
 * 每条都有 signature.test.ts 里的用例钉住。签错的唯一表现是上游回 "密钥错误"，
 * 没有任何中间信息可以二分，所以这里宁可啰嗦。
 */

import { createHash } from "node:crypto";

/** 能出现在签名入参里的值。嵌套只可能有一层（sku）。 */
export type SignValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, string | number | boolean | null | undefined>;

export type SignPayload = Record<string, SignValue>;

/**
 * PHP urlencode（RFC1738）：字母数字与 -_. 原样，空格 → '+'，其余每个**字节** → %XX。
 *
 * 这一步不能省。曾经想当然地认为"编码再解码是恒等变换，直接拼解码后的形态即可"，
 * 但那只在值里不含 '+' 和 '%' 时成立：值里的字面量 '+' 必须先被编成 %2B，
 * 才能在随后的 urldecode 里还原成 '+'；跳过编码的话它会被当成空格解掉。
 * 同理值里的 '%41' 会被误解成 'A'。所以老老实实编码，再整串解回来。
 */
function urlencodePhp(input: string): string {
  let out = "";
  for (const byte of Buffer.from(input, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.]/.test(char)) {
      out += char;
    } else if (char === " ") {
      out += "+";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * urldecode 作用在**整串**上 —— 包括 http_build_query 之后才拼上去的 appKey。
 * appKey 没被编码却一起被解了，于是 key 里的 '+' 会变成空格、'%41' 会变成 'A'。
 * 这是 PHP 侧的既有行为，不是笔误；不照抄的话 key 含这些字符时双方签名不一致。
 */
function urldecodeOnce(input: string): string {
  // 必须在**字节**层面解码后再按 UTF-8 组装：中文一个字符是三个 %XX，
  // 逐个 String.fromCharCode 会解成三个 Latin-1 字符，md5 的输入就错了。
  const bytes: number[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (char === "+") {
      bytes.push(0x20);
      continue;
    }

    if (char === "%") {
      const hex = input.slice(i + 1, i + 3);
      // decodeURIComponent 遇到落单的 '%' 会抛；PHP urldecode 是原样保留。
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }

    bytes.push(...Buffer.from(char, "utf8"));
  }

  return Buffer.from(bytes).toString("utf8");
}

/**
 * PHP 把标量转成查询串时的口径：bool 走 int 再走 string，
 * 所以 true → "1"、false → "0"（不是 "" ——这点错了会让 false 字段整个消失）。
 */
function scalarToQueryString(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/**
 * 生成待签名的明文（即 PHP 里 md5() 的入参）。单独导出是为了排障时能把
 * 两端的明文摆在一起 diff —— 只比对最终 md5 是看不出哪一个字段错位的。
 */
export function buildSignBase(payload: SignPayload, appKey: string): string {
  const pairs: string[] = [];

  // ksort：PHP 对两个非数字字符串键走 strcmp，即按字节序。对接用到的键
  // （app_id / contact / num / race / request_no / shared_code / sku …）全是
  // 非数字，所以按码位排序与 PHP 一致。若将来出现纯数字键，PHP 会改走数值
  // 比较，届时这里必须同步改 —— 现在不预先支持，避免写出无人验证的分支。
  const keys = Object.keys(payload).sort();

  for (const key of keys) {
    // 1) sign 自身不参与签名。
    if (key === "sign") continue;

    const value = payload[key];

    // 2) http_build_query 直接跳过 null 值（连 "k=" 都不会生成）。
    //    undefined 在 JS 侧等价于"这个字段没传"，按同样口径跳过。
    if (value === null || value === undefined) continue;

    // 3) 只有**顶层**的空字符串会被 unset 掉。嵌套在 sku 里的空串不受影响，
    //    仍会生成 "sku[k]=" 这样的空值项。
    if (value === "") continue;

    if (typeof value === "object") {
      // 4) 嵌套数组展开成 sku%5Bk%5D=v，urldecode 后是 sku[k]=v。
      //    子键顺序按插入序，PHP 侧 ksort 只作用于顶层，不要在这里排序。
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue === null || subValue === undefined) continue;
        const name = urlencodePhp(`${key}[${subKey}]`);
        pairs.push(`${name}=${urlencodePhp(scalarToQueryString(subValue))}`);
      }
      continue;
    }

    pairs.push(`${urlencodePhp(key)}=${urlencodePhp(scalarToQueryString(value))}`);
  }

  // 5) appKey 拼在查询串之后，然后**整串**一起 urldecode（见 urldecodeOnce 注释）。
  return urldecodeOnce(`${pairs.join("&")}&key=${appKey}`);
}

/** 计算 sign 字段的值。 */
export function generateSignature(payload: SignPayload, appKey: string): string {
  return createHash("md5").update(buildSignBase(payload, appKey), "utf8").digest("hex");
}

/**
 * 产出可直接 POST 的表单体：原始字段 + sign。
 * 注意签名用的是**解码后**的明文，而发送时又要按 application/x-www-form-urlencoded
 * 重新编码 —— 两者不是同一个串，别试图复用。
 */
export function signedForm(payload: SignPayload, appKey: string): URLSearchParams {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (key === "sign") continue;
    if (value === null || value === undefined || value === "") continue;

    if (typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue === null || subValue === undefined) continue;
        form.append(`${key}[${subKey}]`, scalarToQueryString(subValue));
      }
      continue;
    }

    form.append(key, scalarToQueryString(value));
  }

  form.append("sign", generateSignature(payload, appKey));
  return form;
}
