"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * 商品搜索。
 *
 * 受控输入 + 防抖后写回 URL —— 让搜索结果可被分享、可被前进后退，
 * 而不是只活在组件 state 里。
 */
export function SearchBox({
  placeholder,
  defaultValue,
}: {
  placeholder: string;
  defaultValue: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    // 输入停止 300ms 后才导航。每敲一个字母就打一次服务端渲染既慢又浪费。
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set("q", value.trim());
      else next.delete("q");
      const query = next.toString();
      router.replace(query ? `/?${query}` : "/", { scroll: false });
    }, 300);

    return () => clearTimeout(timer);
    // params 每次导航都是新对象，放进依赖会造成循环。只跟随输入值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="tokyo-search-combo">
      <label className="tokyo-searchbox tokyo-searchbox-combo">
        <i className="fa-duotone fa-regular fa-magnifying-glass" aria-hidden />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
    </div>
  );
}
