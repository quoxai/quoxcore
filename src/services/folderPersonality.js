/**
 * Folder Personality Service
 *
 * Generates and manages folder "personalities" - contextual descriptions
 * that help the AI understand what a folder contains and how to respond.
 *
 * Features:
 * - Auto-generate personality from file analysis
 * - Custom per-folder instructions
 * - Topic extraction and summarization
 * - Personality refresh on content changes
 *
 * Premium feature - enhanced analysis requires Advanced Memory plugin.
 */

import { listFiles, getFile, getFolder, updateFolder } from './fileStorage'
import { isPremiumFilesAvailable } from './fileMemoryBridge'
import { extractTextContent } from './fileEmbeddings'

// Personality storage key
const PERSONALITY_KEY = 'quox-folder-personalities'

// Default personality template
const DEFAULT_PERSONALITY = {
  summary: '',
  topics: [],
  fileTypes: [],
  customInstructions: '',
  generatedAt: null,
  autoRefresh: true
}

/**
 * Get stored personalities from localStorage
 */
function getStoredPersonalities() {
  try {
    const stored = localStorage.getItem(PERSONALITY_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

/**
 * Save personalities to localStorage
 */
function savePersonalities(personalities) {
  try {
    localStorage.setItem(PERSONALITY_KEY, JSON.stringify(personalities))
  } catch (err) {
    console.warn('[FolderPersonality] Failed to save:', err)
  }
}

/**
 * Get personality for a folder
 *
 * @param {string} folderPath - Folder path
 * @returns {Object|null} Folder personality
 */
export function getFolderPersonality(folderPath) {
  const personalities = getStoredPersonalities()
  return personalities[folderPath] || null
}

/**
 * Set custom instructions for a folder
 *
 * @param {string} folderPath - Folder path
 * @param {string} instructions - Custom instructions
 */
export function setFolderInstructions(folderPath, instructions) {
  const personalities = getStoredPersonalities()

  if (!personalities[folderPath]) {
    personalities[folderPath] = { ...DEFAULT_PERSONALITY }
  }

  personalities[folderPath].customInstructions = instructions
  personalities[folderPath].updatedAt = Date.now()

  savePersonalities(personalities)

  // Also update folder metadata
  const folder = getFolder(folderPath)
  if (folder) {
    updateFolder(folderPath, {
      customInstructions: instructions
    })
  }

  return personalities[folderPath]
}

/**
 * Get custom instructions for a folder
 *
 * @param {string} folderPath - Folder path
 * @returns {string} Custom instructions
 */
export function getFolderInstructions(folderPath) {
  const personality = getFolderPersonality(folderPath)
  return personality?.customInstructions || ''
}

/**
 * Generate personality for a folder by analyzing its contents
 *
 * @param {string} folderPath - Folder to analyze
 * @param {Object} options - Options
 * @returns {Object} Generated personality
 */
export async function generateFolderPersonality(folderPath, options = {}) {
  const { forceRefresh = false, recursive = false } = options

  // Check if we have a recent personality
  const existing = getFolderPersonality(folderPath)
  if (existing && !forceRefresh && existing.generatedAt) {
    const age = Date.now() - existing.generatedAt
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours

    if (age < maxAge) {
      return existing
    }
  }

  // Get files in folder
  const files = listFiles({ folderPath, recursive })

  if (files.length === 0) {
    const emptyPersonality = {
      ...DEFAULT_PERSONALITY,
      summary: 'This folder is empty.',
      generatedAt: Date.now(),
      isEmpty: true
    }

    savePersonalityForFolder(folderPath, emptyPersonality)
    return emptyPersonality
  }

  // Analyze files
  const analysis = await analyzeFiles(files)

  // Generate personality
  const personality = {
    summary: generateSummary(analysis, folderPath),
    topics: analysis.topics,
    fileTypes: analysis.fileTypes,
    fileCount: files.length,
    textFileCount: analysis.textFiles,
    totalSize: analysis.totalSize,
    dateRange: analysis.dateRange,
    customInstructions: existing?.customInstructions || '',
    generatedAt: Date.now(),
    autoRefresh: existing?.autoRefresh ?? true
  }

  savePersonalityForFolder(folderPath, personality)

  console.log(`[FolderPersonality] Generated personality for ${folderPath}`)

  return personality
}

/**
 * Analyze files in a folder
 */
async function analyzeFiles(files) {
  const analysis = {
    topics: [],
    fileTypes: {},
    textFiles: 0,
    totalSize: 0,
    dateRange: { earliest: null, latest: null },
    contentSamples: []
  }

  // Word frequency for topic extraction
  const wordFreq = {}
  const stopWords = new Set([
    'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
    'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
    'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
    'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there',
    'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get',
    'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'just',
    'him', 'know', 'take', 'people', 'into', 'year', 'your', 'good',
    'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now',
    'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back',
    'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well',
    'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give',
    'day', 'most', 'us', 'is', 'are', 'was', 'were', 'been', 'has'
  ])

  for (const file of files) {
    // Track file types
    const category = file.category || 'other'
    analysis.fileTypes[category] = (analysis.fileTypes[category] || 0) + 1

    // Track size
    analysis.totalSize += file.size || 0

    // Track dates
    const uploadDate = new Date(file.uploadedAt)
    if (!analysis.dateRange.earliest || uploadDate < analysis.dateRange.earliest) {
      analysis.dateRange.earliest = uploadDate
    }
    if (!analysis.dateRange.latest || uploadDate > analysis.dateRange.latest) {
      analysis.dateRange.latest = uploadDate
    }

    // Analyze text content
    if (['text/plain', 'text/markdown', 'application/json', 'text/csv'].includes(file.type)) {
      analysis.textFiles++

      const fileData = getFile(file.id)
      if (fileData?.data) {
        const text = extractTextContent(fileData)
        if (text) {
          // Extract words for topic analysis
          const words = text.toLowerCase()
            .replace(/[^a-z\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w))

          words.forEach(word => {
            wordFreq[word] = (wordFreq[word] || 0) + 1
          })

          // Store content sample
          if (analysis.contentSamples.length < 3) {
            analysis.contentSamples.push({
              name: file.name,
              preview: text.substring(0, 200)
            })
          }
        }
      }
    }
  }

  // Extract top topics
  analysis.topics = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word)

  return analysis
}

/**
 * Generate summary text from analysis
 */
function generateSummary(analysis, folderPath) {
  const folder = getFolder(folderPath)
  const folderName = folder?.name || folderPath.split('/').pop() || 'folder'

  const parts = []

  // File count and types
  const typeNames = Object.keys(analysis.fileTypes)
  if (typeNames.length === 1) {
    parts.push(`Contains ${analysis.textFileCount || typeNames.length} ${typeNames[0]} files.`)
  } else {
    const typeSummary = Object.entries(analysis.fileTypes)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ')
    parts.push(`Contains ${typeSummary}.`)
  }

  // Topics
  if (analysis.topics.length > 0) {
    const topTopics = analysis.topics.slice(0, 5)
    parts.push(`Main topics: ${topTopics.join(', ')}.`)
  }

  // Date range
  if (analysis.dateRange.earliest && analysis.dateRange.latest) {
    const earliest = analysis.dateRange.earliest.toLocaleDateString()
    const latest = analysis.dateRange.latest.toLocaleDateString()
    if (earliest === latest) {
      parts.push(`Files from ${earliest}.`)
    } else {
      parts.push(`Files from ${earliest} to ${latest}.`)
    }
  }

  return parts.join(' ')
}

/**
 * Save personality for a specific folder
 */
function savePersonalityForFolder(folderPath, personality) {
  const personalities = getStoredPersonalities()
  personalities[folderPath] = personality
  savePersonalities(personalities)

  // Also update folder metadata with personality
  try {
    updateFolder(folderPath, { personality: personality.summary })
  } catch {
    // Folder might not exist in storage
  }
}

/**
 * Clear personality for a folder
 *
 * @param {string} folderPath - Folder path
 */
export function clearFolderPersonality(folderPath) {
  const personalities = getStoredPersonalities()
  delete personalities[folderPath]
  savePersonalities(personalities)
}

/**
 * Get all folder personalities
 *
 * @returns {Object} All personalities keyed by folder path
 */
export function getAllPersonalities() {
  return getStoredPersonalities()
}

/**
 * Generate system prompt addition from folder personality
 *
 * @param {string} folderPath - Folder path
 * @returns {string} System prompt addition
 */
export function getPersonalityPrompt(folderPath) {
  const personality = getFolderPersonality(folderPath)
  if (!personality) return ''

  const parts = []

  // Add folder summary
  if (personality.summary) {
    parts.push(`## About this folder:\n${personality.summary}`)
  }

  // Add topics
  if (personality.topics?.length > 0) {
    parts.push(`\n## Key topics in this folder:\n${personality.topics.join(', ')}`)
  }

  // Add custom instructions
  if (personality.customInstructions) {
    parts.push(`\n## Special instructions for this folder:\n${personality.customInstructions}`)
  }

  return parts.join('\n')
}

/**
 * Check if folder personality needs refresh
 *
 * @param {string} folderPath - Folder path
 * @returns {boolean} True if refresh needed
 */
export function needsPersonalityRefresh(folderPath) {
  const personality = getFolderPersonality(folderPath)

  if (!personality || !personality.generatedAt) {
    return true
  }

  if (!personality.autoRefresh) {
    return false
  }

  const age = Date.now() - personality.generatedAt
  const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

  return age > maxAge
}

/**
 * Set auto-refresh preference for folder
 *
 * @param {string} folderPath - Folder path
 * @param {boolean} enabled - Auto-refresh enabled
 */
export function setAutoRefresh(folderPath, enabled) {
  const personalities = getStoredPersonalities()

  if (!personalities[folderPath]) {
    personalities[folderPath] = { ...DEFAULT_PERSONALITY }
  }

  personalities[folderPath].autoRefresh = enabled
  savePersonalities(personalities)
}

/**
 * Refresh personalities for all folders that need it
 */
export async function refreshStalePersonalities() {
  const personalities = getStoredPersonalities()
  const refreshed = []

  for (const [folderPath, personality] of Object.entries(personalities)) {
    if (needsPersonalityRefresh(folderPath)) {
      await generateFolderPersonality(folderPath, { forceRefresh: true })
      refreshed.push(folderPath)
    }
  }

  return refreshed
}

export default {
  getFolderPersonality,
  setFolderInstructions,
  getFolderInstructions,
  generateFolderPersonality,
  clearFolderPersonality,
  getAllPersonalities,
  getPersonalityPrompt,
  needsPersonalityRefresh,
  setAutoRefresh,
  refreshStalePersonalities
}
