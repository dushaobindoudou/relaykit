/**
 * 文案字典。
 *
 * 不引 i18n 库：这个站的文案量小且固定，一个带类型的对象就够了，
 * 而且能让「漏翻一条」变成编译期错误而不是线上显示成 key。
 *
 * Dict 的类型由 en 推导，zh 必须结构完全一致 —— 少一个键就编译不过。
 */

export const en = {
  nav: {
    products: "Products",
    findOrder: "Find my order",
    help: "Help",
    pricesIn: (currency: string) => `Prices in ${currency}`,
    search: "Search products",
    allCategories: "All products",
    signIn: "Sign in",
  },
  home: {
    tagline: (currency: string) =>
      `Pay in ${currency}. Your code is delivered automatically once payment confirms on-chain.`,
    empty: "No products listed yet.",
    emptyHint:
      "The catalog syncs every 15 minutes. If it stays empty, check the health endpoint for the per-product reason.",
    noMatch: "No products match your search.",
    itemCount: (count: number) => `${count} ${count === 1 ? "item" : "items"}`,
  },
  product: {
    from: "from",
    options: (count: number) => `${count} options`,
    inStock: "In stock",
    outOfStock: "Out of stock",
    autoDelivery: "Instant delivery",
    manualDelivery: "Manual delivery",
    manualNote:
      "This item is fulfilled by hand. Delivery is not instant; you will be contacted by email.",
    backToAll: "All products",
    howItWorks: "How it works",
    step1: "Pick an option and enter your email.",
    step2: "Send the exact amount to the address shown.",
    step3: "Your code appears on the order page.",
    exactAmountNote:
      "Send the exact amount shown at checkout. The trailing decimals identify your order, so a rounded amount cannot be matched automatically.",
    details: "Details",
  },
  buy: {
    option: "Option",
    standard: "Standard",
    quantity: "Quantity",
    email: "Email",
    emailHint: "Used to find your order later. Not shared.",
    password: "Order password",
    passwordHint: "Set any password. You need it to view your code again.",
    payWith: "Pay with",
    total: "Total",
    submit: "Continue to payment",
    creating: "Creating order…",
    soldOut: "Out of stock",
    notConfigured: "Payment not configured",
    window: (minutes: number) => `You will have ${minutes} minutes to send payment.`,
  },
  order: {
    orderNumber: "Order",
    sendExactly: "Send exactly",
    left: "left",
    address: "Address",
    amount: "Amount",
    copy: "Copy",
    copied: "Copied",
    yourCode: "Your code",
    item: "Item",
    quantity: "Quantity",
    total: "Total",
    placed: "Placed",
    bookmark: "Bookmark this page. You can also find this order again from the",
    lookupLink: "order lookup",
    bookmarkTail: "using your order number and password.",
    enterPassword: "Enter your order password to reveal the code.",
    openLookup: "Open order lookup",
    exactDecimals:
      "The exact decimals identify your order. Sending a rounded amount means we cannot match your payment automatically.",
  },
  status: {
    draft: { label: "Preparing", help: "Setting up your order." },
    awaiting_payment: {
      label: "Awaiting payment",
      help: "Send the exact amount below. This page updates by itself.",
    },
    paid: { label: "Payment received", help: "Confirmed on-chain. Fetching your code now." },
    procuring: { label: "Getting your code", help: "This usually takes a few seconds." },
    fulfilled: { label: "Delivered", help: "Your code is ready below." },
    procurement_failed: {
      label: "Could not be filled",
      help: "The item became unavailable. Your payment will be refunded.",
    },
    refunded: { label: "Refunded", help: "This order was refunded." },
    needs_review: {
      label: "Being checked",
      help: "Something needs a human look. We will contact you by email.",
    },
    expired: {
      label: "Expired",
      help: "No payment arrived in time. Place a new order to try again.",
    },
  },
  lookup: {
    title: "Find my order",
    intro:
      "Enter the order number from your confirmation page and the password you set when ordering.",
    orderNumber: "Order number",
    password: "Order password",
    submit: "Find order",
    checking: "Checking…",
    notFound: "Order not found, or the password does not match.",
    failed: "Something went wrong. Please try again.",
  },
  setup: {
    title: "Setup required",
    intro: "The store is not configured yet, so customers cannot see any products.",
    diagnostics: "Full diagnostics at",
    demoMode: "Demo mode",
    demoBody: (chains: string) =>
      `No receiving address is configured for ${chains}, so orders will be rejected. Set one and redeploy to start selling.`,
  },
  footer: {
    note: "Codes are delivered automatically after payment confirms on-chain.",
    shop: "Shop",
    support: "Support",
  },
  account: {
    signIn: "Sign in",
    signUp: "Create account",
    signOut: "Sign out",
    email: "Email",
    password: "Password",
    passwordHint: "At least 8 characters.",
    noAccount: "No account yet?",
    haveAccount: "Already have an account?",
    dashboard: "Account",
    balance: "Balance",
    topUp: "Top up",
    topUpAmount: "Amount to add",
    myOrders: "My orders",
    transactions: "Balance history",
    noOrders: "No orders yet.",
    noTransactions: "No balance activity yet.",
    emailTaken: "That email is already registered.",
    badCredentials: "Email or password is incorrect.",
    weakPassword: "Password must be at least 8 characters.",
    invalidEmail: "Please enter a valid email address.",
    payWithBalance: "Pay with balance",
    insufficient: "Not enough balance",
    totalSpent: "Total spent",
  },
  coupon: {
    label: "Discount code",
    apply: "Apply",
    applied: "Applied",
    remove: "Remove",
    subtotal: "Subtotal",
    discount: "Discount",
  },
  help: {
    title: "Help center",
    intro: "Guides, payment questions, and how delivery works.",
    empty: "No articles yet.",
    back: "Back to help center",
  },
};

/**
 * 字典结构。zh 必须与它逐键一致 —— 漏一条是编译期错误，不是线上显示成 key。
 *
 * 注意 en 上**不能**加 as const：那会把每个值收窄成字面量类型，
 * 于是「中文值不等于英文字面量」也成了类型错误。
 */
export type Dict = typeof en;

export const zh: Dict = {
  nav: {
    products: "全部商品",
    findOrder: "订单查询",
    help: "帮助",
    pricesIn: (currency: string) => `以 ${currency} 计价`,
    search: "搜索商品",
    allCategories: "全部商品",
    signIn: "登录",
  },
  home: {
    tagline: (currency: string) =>
      `使用 ${currency} 付款。链上确认后自动发货，无需等待人工。`,
    empty: "暂无可售商品",
    emptyHint:
      "商品目录每 15 分钟自动同步。若同步后仍为空，可在健康检查接口看到每个商品被下架的具体原因。",
    noMatch: "没有匹配的商品",
    itemCount: (count: number) => `${count} 件商品`,
  },
  product: {
    from: "起",
    options: (count: number) => `${count} 个规格`,
    inStock: "有货",
    outOfStock: "缺货",
    autoDelivery: "自动发货",
    manualDelivery: "人工发货",
    manualNote: "该商品需人工处理，非即时发货，我们会通过邮件与你联系。",
    backToAll: "全部商品",
    howItWorks: "购买流程",
    step1: "选择规格并填写邮箱",
    step2: "向页面显示的地址转入准确金额",
    step3: "订单页自动出现卡密",
    exactAmountNote:
      "请转入结算页显示的准确金额。末尾几位小数用于识别你的订单，转整数会导致无法自动匹配。",
    details: "商品详情",
  },
  buy: {
    option: "规格",
    standard: "默认规格",
    quantity: "数量",
    email: "邮箱",
    emailHint: "用于后续查询订单，不会外传。",
    password: "订单口令",
    passwordHint: "自行设置，用于再次查看卡密。",
    payWith: "支付方式",
    total: "合计",
    submit: "去支付",
    creating: "正在创建订单…",
    soldOut: "已售罄",
    notConfigured: "收款未配置",
    window: (minutes: number) => `创建后有 ${minutes} 分钟的付款时间。`,
  },
  order: {
    orderNumber: "订单号",
    sendExactly: "请转入准确金额",
    left: "后过期",
    address: "收款地址",
    amount: "金额",
    copy: "复制",
    copied: "已复制",
    yourCode: "你的卡密",
    item: "商品",
    quantity: "数量",
    total: "合计",
    placed: "下单时间",
    bookmark: "建议收藏本页。也可以通过",
    lookupLink: "订单查询",
    bookmarkTail: "用订单号和口令找回。",
    enterPassword: "输入订单口令以查看卡密。",
    openLookup: "前往订单查询",
    exactDecimals:
      "末尾小数用于识别你的订单。转入取整后的金额会导致无法自动匹配到你。",
  },
  status: {
    draft: { label: "准备中", help: "正在创建订单。" },
    awaiting_payment: {
      label: "等待付款",
      help: "请转入下方的准确金额，本页会自动刷新状态。",
    },
    paid: { label: "已收到付款", help: "链上已确认，正在为你取货。" },
    procuring: { label: "正在取货", help: "通常只需几秒。" },
    fulfilled: { label: "已发货", help: "卡密已在下方。" },
    procurement_failed: {
      label: "无法完成",
      help: "商品已不可用，款项将退还给你。",
    },
    refunded: { label: "已退款", help: "该订单已退款。" },
    needs_review: {
      label: "人工核查中",
      help: "该订单需要人工确认，我们会通过邮件与你联系。",
    },
    expired: {
      label: "已过期",
      help: "未在时限内收到付款。如需购买请重新下单。",
    },
  },
  lookup: {
    title: "订单查询",
    intro: "输入下单页显示的订单号，以及你下单时设置的口令。",
    orderNumber: "订单号",
    password: "订单口令",
    submit: "查询",
    checking: "查询中…",
    notFound: "找不到该订单，或口令不正确。",
    failed: "出错了，请稍后重试。",
  },
  setup: {
    title: "配置尚未就绪",
    intro: "店铺配置有误，客户暂时看不到商品。",
    diagnostics: "完整诊断见",
    demoMode: "演示模式",
    demoBody: (chains: string) =>
      `${chains} 的收款地址尚未配置，下单会被拒绝。设置后重新部署即可开售。`,
  },
  footer: {
    note: "链上确认付款后自动发货。",
    shop: "购物",
    support: "支持",
  },
  account: {
    signIn: "登录",
    signUp: "注册",
    signOut: "退出",
    email: "邮箱",
    password: "密码",
    passwordHint: "至少 8 位。",
    noAccount: "还没有账号？",
    haveAccount: "已有账号？",
    dashboard: "我的账户",
    balance: "余额",
    topUp: "充值",
    topUpAmount: "充值金额",
    myOrders: "我的订单",
    transactions: "余额明细",
    noOrders: "暂无订单",
    noTransactions: "暂无余额变动",
    emailTaken: "该邮箱已被注册",
    badCredentials: "邮箱或密码不正确",
    weakPassword: "密码至少 8 位",
    invalidEmail: "请输入有效的邮箱地址",
    payWithBalance: "余额支付",
    insufficient: "余额不足",
    totalSpent: "累计消费",
  },
  coupon: {
    label: "优惠码",
    apply: "使用",
    applied: "已使用",
    remove: "移除",
    subtotal: "小计",
    discount: "优惠",
  },
  help: {
    title: "帮助中心",
    intro: "使用教程、付款说明与发货流程。",
    empty: "暂无文章",
    back: "返回帮助中心",
  },
};

export const DICTS = { en, "zh-CN": zh } as const;
export type Locale = keyof typeof DICTS;
export const LOCALES: Locale[] = ["en", "zh-CN"];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  "zh-CN": "中文",
};
