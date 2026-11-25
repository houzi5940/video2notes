/**
 * 适配器注册表 —— 加平台只改这里 + 新建一个 adapters/<name>.mjs
 * 契约见 README「适配器契约」。match() 必须同步、只判 URL；fetch() 负责取材料。
 */
import bilibili from './bilibili.mjs'
import article from './article.mjs'
import douyin from './douyin.mjs'

// 顺序 = 优先级（先窄后宽；article 是通配兜底，必须放最后）
export const adapters = [bilibili, douyin, article]
export default adapters
