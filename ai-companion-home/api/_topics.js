// 共享的多层 topic taxonomy，被 memories.js（检索/展示）和 messages.js（记忆提取写入）同时使用，
// 保证伴侣记得的东西用同一套分类体系，相关 topic（比如 学习和工作 下面的 学校）
// 能连成一棵树，而不是散落成互不相关的关键词。
// 记忆分类树：可以按你自己的生活改成任何分类，children 是子分类
export const TOPIC_TAXONOMY = {
  '日常': {
    keywords: ['日常', '吃饭', '睡觉', '咖啡', '散步', '超市', '做饭', '天气', '衣服', '家', '卧室', '客厅'],
  },
  '学习和工作': {
    keywords: ['学习', '工作', '实习', '求职', '面试', '作业', '项目', '考试', '公司', '效率'],
    children: {
      '学校': { keywords: ['学校', '大学', '课程', '教授', '宿舍', '图书馆', '同学'] },
    },
  },
  '家人朋友': {
    keywords: ['家人', '父母', '妈妈', '爸爸', '朋友', '室友', '亲戚', '家乡'],
  },
  '兴趣爱好': {
    keywords: ['游戏', '电影', '电视剧', '音乐', '画画', '读书', '运动', '旅行', '美食', '展览'],
  },
  '过去的经历': {
    keywords: ['小时候', '高中', '中学', '毕业', '以前', '回忆'],
  },
}

function buildTopicPaths() {
  const paths = []
  for (const [parentName, parent] of Object.entries(TOPIC_TAXONOMY)) {
    paths.push({ path: parentName, label: parentName, parent: null, keywords: parent.keywords })
    for (const [childName, child] of Object.entries(parent.children || {})) {
      paths.push({ path: `${parentName}/${childName}`, label: childName, parent: parentName, keywords: child.keywords })
    }
  }
  return paths
}

export const TOPIC_PATHS = buildTopicPaths()
export const VALID_TOPIC_PATHS = new Set(TOPIC_PATHS.map(topic => topic.path))

export function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '')
}

export function matchTopicsInText(text) {
  const haystack = normalizedText(text)
  if (!haystack) return []
  return TOPIC_PATHS
    .filter(topic => topic.keywords.some(keyword => haystack.includes(normalizedText(keyword))))
    .map(topic => topic.path)
}

// 优先使用写入时由 LLM 判定并校验过的 topics；只有旧数据没有这个字段时才回退到关键词推断。
export function inferTopics(memory) {
  if (Array.isArray(memory.topics)) {
    const valid = memory.topics.filter(topic => VALID_TOPIC_PATHS.has(topic))
    if (valid.length) return valid.slice(0, 3)
  }
  const haystack = [memory.title, memory.summary, ...(memory.retrieval_tags || [])].join(' ')
  const matches = matchTopicsInText(haystack)
  return matches.length ? matches.slice(0, 3) : ['日常']
}

export function buildTopicGraph(memories) {
  const nodes = TOPIC_PATHS.map(topic => ({ id: topic.path, label: topic.label, parent: topic.parent, count: 0 }))
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const coMap = new Map()
  for (const memory of memories) {
    const topics = inferTopics(memory)
    for (const topic of topics) nodeById.get(topic) && (nodeById.get(topic).count += 1)
    for (let i = 0; i < topics.length; i += 1) {
      for (let j = i + 1; j < topics.length; j += 1) {
        const [a, b] = [topics[i], topics[j]].sort()
        if (a === b) continue
        const key = `${a}|${b}`
        coMap.set(key, (coMap.get(key) || 0) + 1)
      }
    }
  }
  const edges = []
  for (const topic of TOPIC_PATHS) {
    if (topic.parent) edges.push({ source: topic.parent, target: topic.path, type: 'structural', weight: 1 })
  }
  for (const [key, weight] of coMap) {
    const [source, target] = key.split('|')
    edges.push({ source, target, type: 'cooccurrence', weight })
  }
  return { nodes, edges }
}
