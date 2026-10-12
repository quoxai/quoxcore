/**
 * File Operations Agent Service
 *
 * Skills for analyzing, summarizing, and extracting information from files.
 * Used by the ARCHIVIST assistant for document intelligence.
 *
 * Skills:
 * - summarize: Generate summary with key points
 * - compare: Diff and semantic comparison
 * - extract: Extract structured data to JSON
 * - findContradictions: Cross-file consistency check
 * - generateQuiz: Create Q&A from content
 *
 * Premium feature - requires Advanced Memory plugin.
 */

import { getFile, listFiles, uploadFile } from './fileStorage'
import { isPremiumFilesAvailable } from './fileMemoryBridge'
import { extractTextContent } from './fileEmbeddings'

// Skill definitions
export const FILE_SKILLS = {
  summarize: {
    id: 'summarize',
    name: 'Summarize',
    description: 'Generate a concise summary with key points',
    icon: 'document',
    minFiles: 1,
    maxFiles: 1
  },
  compare: {
    id: 'compare',
    name: 'Compare',
    description: 'Compare two files for differences and similarities',
    icon: 'compare',
    minFiles: 2,
    maxFiles: 2
  },
  extract: {
    id: 'extract',
    name: 'Extract',
    description: 'Extract structured data to JSON format',
    icon: 'code',
    minFiles: 1,
    maxFiles: 1
  },
  analyze: {
    id: 'analyze',
    name: 'Analyze',
    description: 'Deep analysis of content, themes, and insights',
    icon: 'search',
    minFiles: 1,
    maxFiles: 5
  },
  findContradictions: {
    id: 'findContradictions',
    name: 'Find Contradictions',
    description: 'Identify inconsistencies across multiple files',
    icon: 'warning',
    minFiles: 2,
    maxFiles: 10
  },
  generateQuiz: {
    id: 'generateQuiz',
    name: 'Generate Quiz',
    description: 'Create Q&A questions from file content',
    icon: 'quiz',
    minFiles: 1,
    maxFiles: 1
  }
}

/**
 * Check if file operations are available
 */
export function isFileOpsAvailable() {
  return isPremiumFilesAvailable()
}

/**
 * Get available skills based on file selection
 *
 * @param {number} fileCount - Number of selected files
 * @returns {Array} Available skills
 */
export function getAvailableSkills(fileCount) {
  if (!isFileOpsAvailable()) {
    return []
  }

  return Object.values(FILE_SKILLS).filter(skill => {
    return fileCount >= skill.minFiles && fileCount <= skill.maxFiles
  })
}

/**
 * Read and validate file content
 *
 * @param {string} fileId - File ID
 * @returns {Object} File data with extracted text
 */
async function readFileContent(fileId) {
  const fileData = getFile(fileId)
  if (!fileData) {
    throw new Error(`File not found: ${fileId}`)
  }

  const textContent = extractTextContent(fileData)
  if (!textContent) {
    throw new Error(`Could not extract text from file: ${fileData.name}`)
  }

  return {
    id: fileId,
    name: fileData.name,
    type: fileData.type,
    content: textContent,
    size: fileData.size
  }
}

/**
 * Summarize a file
 *
 * @param {string} fileId - File to summarize
 * @param {Object} options - Options
 * @returns {Object} Summary result
 */
export async function summarize(fileId, options = {}) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  const { maxLength = 500, includeKeyPoints = true } = options

  try {
    const file = await readFileContent(fileId)

    // Generate prompt for AI summarization
    const prompt = `Summarize the following document in ${maxLength} characters or less.
${includeKeyPoints ? 'Include 3-5 key points as bullet points.' : ''}

Document: ${file.name}
Content:
${file.content.substring(0, 20000)}

Format your response as JSON:
{
  "summary": "concise summary here",
  "keyPoints": ["point 1", "point 2", ...],
  "wordCount": number,
  "mainTopics": ["topic1", "topic2"]
}`

    // For now, return a structured placeholder that could be sent to Claude API
    // In production, this would call the chat webhook
    return {
      skillId: 'summarize',
      status: 'ready',
      file: { id: file.id, name: file.name },
      prompt,
      // Placeholder summary (in production, this comes from AI)
      result: {
        summary: `This document "${file.name}" contains ${file.content.length} characters of content.`,
        keyPoints: extractKeyPoints(file.content),
        wordCount: file.content.split(/\s+/).length,
        mainTopics: extractTopics(file.content)
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Compare two files
 *
 * @param {string} fileId1 - First file
 * @param {string} fileId2 - Second file
 * @param {Object} options - Options
 * @returns {Object} Comparison result
 */
export async function compare(fileId1, fileId2, options = {}) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  try {
    const file1 = await readFileContent(fileId1)
    const file2 = await readFileContent(fileId2)

    // Generate prompt for AI comparison
    const prompt = `Compare these two documents and identify:
1. Key similarities
2. Key differences
3. Contradictions (if any)
4. Which document is more comprehensive

Document 1: ${file1.name}
${file1.content.substring(0, 10000)}

Document 2: ${file2.name}
${file2.content.substring(0, 10000)}

Format your response as JSON:
{
  "similarities": ["similarity 1", ...],
  "differences": ["difference 1", ...],
  "contradictions": ["contradiction 1", ...],
  "moreComprehensive": "document1 | document2 | equal",
  "overlapPercentage": number
}`

    // Calculate basic comparison metrics
    const words1 = new Set(file1.content.toLowerCase().split(/\s+/))
    const words2 = new Set(file2.content.toLowerCase().split(/\s+/))
    const overlap = [...words1].filter(w => words2.has(w)).length
    const overlapPercentage = Math.round((overlap / Math.max(words1.size, words2.size)) * 100)

    return {
      skillId: 'compare',
      status: 'ready',
      files: [
        { id: file1.id, name: file1.name, wordCount: words1.size },
        { id: file2.id, name: file2.name, wordCount: words2.size }
      ],
      prompt,
      result: {
        overlapPercentage,
        file1Length: file1.content.length,
        file2Length: file2.content.length,
        similarities: [`Both documents discuss similar topics`],
        differences: [
          `${file1.name}: ${words1.size} words`,
          `${file2.name}: ${words2.size} words`
        ],
        moreComprehensive: words1.size > words2.size ? file1.name : file2.name
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Extract structured data from file
 *
 * @param {string} fileId - File to extract from
 * @param {Object} schema - Expected schema (optional)
 * @returns {Object} Extraction result
 */
export async function extract(fileId, schema = null) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  try {
    const file = await readFileContent(fileId)

    // Determine if it's already JSON
    if (file.type === 'application/json') {
      try {
        const parsed = JSON.parse(file.content)
        return {
          skillId: 'extract',
          status: 'complete',
          file: { id: file.id, name: file.name },
          result: {
            format: 'json',
            data: parsed,
            isStructured: true
          }
        }
      } catch {
        // Not valid JSON, continue with extraction
      }
    }

    // Generate prompt for AI extraction
    const schemaHint = schema
      ? `Extract data matching this schema: ${JSON.stringify(schema)}`
      : 'Identify and extract any structured data (names, dates, numbers, lists, key-value pairs)'

    const prompt = `${schemaHint}

Document: ${file.name}
Content:
${file.content.substring(0, 15000)}

Format your response as JSON:
{
  "extractedData": { ... },
  "confidence": number (0-100),
  "fieldsFound": ["field1", "field2"]
}`

    // Basic extraction for demo
    const extractedData = extractBasicData(file.content)

    return {
      skillId: 'extract',
      status: 'ready',
      file: { id: file.id, name: file.name },
      prompt,
      result: {
        format: 'text',
        data: extractedData,
        isStructured: false,
        fieldsFound: Object.keys(extractedData)
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Analyze file(s) for insights
 *
 * @param {Array<string>} fileIds - Files to analyze
 * @param {Object} options - Analysis options
 * @returns {Object} Analysis result
 */
export async function analyze(fileIds, options = {}) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  try {
    const files = await Promise.all(fileIds.map(readFileContent))

    const prompt = `Analyze the following document(s) and provide:
1. Main themes and topics
2. Key insights
3. Writing style assessment
4. Recommendations or action items

${files.map((f, i) => `Document ${i + 1}: ${f.name}\n${f.content.substring(0, 8000)}`).join('\n\n---\n\n')}

Format your response as JSON:
{
  "themes": ["theme1", ...],
  "insights": ["insight1", ...],
  "style": "formal | informal | technical | etc",
  "actionItems": ["item1", ...],
  "sentiment": "positive | negative | neutral"
}`

    return {
      skillId: 'analyze',
      status: 'ready',
      files: files.map(f => ({ id: f.id, name: f.name })),
      prompt,
      result: {
        themes: extractTopics(files.map(f => f.content).join(' ')),
        totalWords: files.reduce((sum, f) => sum + f.content.split(/\s+/).length, 0),
        fileCount: files.length
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Find contradictions across files in a folder
 *
 * @param {string} folderPath - Folder to check
 * @param {Object} options - Options
 * @returns {Object} Contradictions result
 */
export async function findContradictions(folderPath, options = {}) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  try {
    const files = listFiles({ folderPath, recursive: options.recursive })
      .filter(f => ['text/plain', 'text/markdown', 'application/json'].includes(f.type))
      .slice(0, 10) // Limit to 10 files

    if (files.length < 2) {
      return {
        skillId: 'findContradictions',
        status: 'insufficient_files',
        message: 'Need at least 2 text files to check for contradictions'
      }
    }

    const fileContents = await Promise.all(
      files.map(async f => {
        const data = getFile(f.id)
        const text = extractTextContent(data)
        return { ...f, content: text?.substring(0, 5000) || '' }
      })
    )

    const prompt = `Review these documents for contradictions, inconsistencies, or conflicting information.

${fileContents.map((f, i) => `Document ${i + 1}: ${f.name}\n${f.content}`).join('\n\n---\n\n')}

Format your response as JSON:
{
  "contradictions": [
    {
      "topic": "topic name",
      "documents": ["doc1", "doc2"],
      "description": "what contradicts",
      "severity": "minor | moderate | major"
    }
  ],
  "consistentTopics": ["topic1", ...],
  "overallConsistency": "high | medium | low"
}`

    return {
      skillId: 'findContradictions',
      status: 'ready',
      files: files.map(f => ({ id: f.id, name: f.name })),
      prompt,
      result: {
        filesAnalyzed: files.length,
        folderPath
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Generate quiz questions from file content
 *
 * @param {string} fileId - File to generate quiz from
 * @param {Object} options - Options
 * @returns {Object} Quiz result
 */
export async function generateQuiz(fileId, options = {}) {
  if (!isFileOpsAvailable()) {
    return { error: 'premium_required', message: 'File operations require Advanced Memory plugin' }
  }

  const { questionCount = 5, difficulty = 'medium' } = options

  try {
    const file = await readFileContent(fileId)

    const prompt = `Generate ${questionCount} quiz questions based on this document.
Difficulty: ${difficulty}
Mix of question types: multiple choice, true/false, and short answer.

Document: ${file.name}
Content:
${file.content.substring(0, 15000)}

Format your response as JSON:
{
  "questions": [
    {
      "id": 1,
      "type": "multiple_choice | true_false | short_answer",
      "question": "question text",
      "options": ["A", "B", "C", "D"] (for multiple choice),
      "answer": "correct answer",
      "explanation": "why this is correct"
    }
  ],
  "topics": ["topics covered"],
  "difficulty": "${difficulty}"
}`

    return {
      skillId: 'generateQuiz',
      status: 'ready',
      file: { id: file.id, name: file.name },
      prompt,
      options: { questionCount, difficulty },
      result: {
        questionCount,
        difficulty,
        sourceLength: file.content.length
      }
    }
  } catch (err) {
    return { error: 'processing_failed', message: err.message }
  }
}

/**
 * Execute a skill
 *
 * @param {string} skillId - Skill to execute
 * @param {Array<string>} fileIds - File IDs
 * @param {Object} options - Skill options
 * @returns {Object} Skill result
 */
export async function executeSkill(skillId, fileIds, options = {}) {
  if (!isFileOpsAvailable()) {
    return {
      error: 'premium_required',
      message: 'File operations require Advanced Memory plugin',
      upgrade: {
        title: 'File Intelligence',
        message: 'Analyze, summarize, and extract data from files with ARCHIVIST.',
        price: '$99 one-time'
      }
    }
  }

  switch (skillId) {
    case 'summarize':
      return summarize(fileIds[0], options)

    case 'compare':
      return compare(fileIds[0], fileIds[1], options)

    case 'extract':
      return extract(fileIds[0], options.schema)

    case 'analyze':
      return analyze(fileIds, options)

    case 'findContradictions':
      return findContradictions(options.folderPath || '/', options)

    case 'generateQuiz':
      return generateQuiz(fileIds[0], options)

    default:
      return { error: 'unknown_skill', message: `Unknown skill: ${skillId}` }
  }
}

/**
 * Save skill result as a new file
 *
 * @param {Object} result - Skill result
 * @param {Object} options - Save options
 * @returns {Object} Saved file info
 */
export async function saveResultAsFile(result, options = {}) {
  const { folderPath = '/', fileName } = options

  const content = JSON.stringify(result.result || result, null, 2)
  const defaultName = `${result.skillId || 'result'}_${Date.now()}.json`

  const file = new File(
    [content],
    fileName || defaultName,
    { type: 'application/json' }
  )

  return uploadFile(file, { folderPath })
}

// ============================================
// Helper Functions
// ============================================

/**
 * Extract key points from text (simple heuristic)
 */
function extractKeyPoints(text, maxPoints = 5) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20)

  // Simple scoring: longer sentences with important words
  const importantWords = ['important', 'key', 'main', 'primary', 'critical', 'essential', 'significant']
  const scored = sentences.map(s => {
    const lower = s.toLowerCase()
    const score = importantWords.reduce((sum, w) => sum + (lower.includes(w) ? 1 : 0), 0)
    return { text: s.trim(), score: score + s.length / 100 }
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPoints)
    .map(s => s.text.substring(0, 150) + (s.text.length > 150 ? '...' : ''))
}

/**
 * Extract main topics from text (simple word frequency)
 */
function extractTopics(text, maxTopics = 5) {
  const words = text.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 4)

  const stopWords = new Set([
    'about', 'after', 'again', 'would', 'could', 'should', 'their', 'there',
    'these', 'those', 'through', 'under', 'where', 'which', 'while', 'being',
    'between', 'before', 'because', 'other', 'another'
  ])

  const freq = {}
  words.forEach(w => {
    if (!stopWords.has(w)) {
      freq[w] = (freq[w] || 0) + 1
    }
  })

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTopics)
    .map(([word]) => word)
}

/**
 * Extract basic structured data from text
 */
function extractBasicData(text) {
  const data = {}

  // Extract emails
  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
  if (emails) data.emails = [...new Set(emails)]

  // Extract URLs
  const urls = text.match(/https?:\/\/[^\s]+/g)
  if (urls) data.urls = [...new Set(urls)]

  // Extract dates
  const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g)
  if (dates) data.dates = [...new Set(dates)]

  // Extract phone numbers
  const phones = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g)
  if (phones) data.phoneNumbers = [...new Set(phones)]

  // Extract numbers
  const numbers = text.match(/\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g)
  if (numbers) data.numbers = [...new Set(numbers)].slice(0, 20)

  return data
}

export default {
  FILE_SKILLS,
  isFileOpsAvailable,
  getAvailableSkills,
  summarize,
  compare,
  extract,
  analyze,
  findContradictions,
  generateQuiz,
  executeSkill,
  saveResultAsFile
}
