import type { CategoryId } from '../src/appTypes.ts'
import { compactWhitespace } from './utils'

type MetadataLookupInput = {
  category: CategoryId
  title: string
  year: number | null
  authorHint?: string | null
}

export type RemoteMetadataMatch = {
  provider: 'AniList' | 'Google Books'
  providerId: string
  description: string | null
  coverImageUrl: string | null
  bannerImageUrl: string | null
  externalUrl: string | null
  sourceName: string | null
  sourceRole: string | null
  year: number | null
  genres: string[]
  tags: string[]
}

type AniListMedia = {
  id: number
  siteUrl: string | null
  description: string | null
  bannerImage: string | null
  seasonYear: number | null
  startDate: {
    year: number | null
  } | null
  coverImage: {
    extraLarge: string | null
    large: string | null
    medium: string | null
  } | null
  title: {
    romaji: string | null
    english: string | null
    native: string | null
    userPreferred: string | null
  }
  genres: string[]
  tags: Array<{
    name: string
    rank: number
    isMediaSpoiler: boolean
  }>
  studios?: {
    nodes: Array<{
      name: string
    }>
  } | null
  staff?: {
    edges: Array<{
      role: string | null
      node: {
        name: {
          full: string | null
        }
      }
    }>
  } | null
}

type GoogleBooksVolume = {
  id: string
  volumeInfo?: {
    title?: string
    subtitle?: string
    authors?: string[]
    categories?: string[]
    publishedDate?: string
    description?: string
    infoLink?: string
    imageLinks?: Partial<Record<'thumbnail' | 'smallThumbnail' | 'small' | 'medium' | 'large' | 'extraLarge', string>>
  }
}

const normalizeTitle = (value: string) =>
  compactWhitespace(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')

const splitTitleTokens = (value: string) =>
  compactWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)

const scoreTitleMatch = (candidateTitles: string[], wantedTitle: string, wantedYear: number | null) => {
  const wantedNormalized = normalizeTitle(wantedTitle)
  const wantedTokens = splitTitleTokens(wantedTitle)
  let bestScore = 0

  for (const candidateTitle of candidateTitles) {
    if (!candidateTitle) {
      continue
    }

    const candidateNormalized = normalizeTitle(candidateTitle)
    const candidateTokens = splitTitleTokens(candidateTitle)
    let score = 0

    if (candidateNormalized === wantedNormalized) {
      score += 120
    } else if (
      candidateNormalized.includes(wantedNormalized) ||
      wantedNormalized.includes(candidateNormalized)
    ) {
      score += 90
    }

    const overlappingTokens = candidateTokens.filter((token) => wantedTokens.includes(token)).length
    score += overlappingTokens * 8

    if (wantedYear != null) {
      if (candidateTitle.includes(String(wantedYear))) {
        score += 10
      }
    }

    bestScore = Math.max(bestScore, score)
  }

  return bestScore
}

const stripHtml = (value: string | null | undefined) =>
  compactWhitespace(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  ) || null

const normalizeImageUrl = (value: string | null | undefined) =>
  value ? value.replace(/^http:\/\//i, 'https://') : null

const extractGoogleBookTags = (categories: string[] | undefined) => {
  if (!categories?.length) {
    return []
  }

  const genericLabels = new Set(['general', 'miscellaneous', 'fiction', 'nonfiction'])
  const tags = new Set<string>()

  for (const category of categories) {
    for (const rawSegment of category.split('/')) {
      const segment = compactWhitespace(rawSegment)
      if (!segment || genericLabels.has(segment.toLowerCase())) {
        continue
      }

      tags.add(segment)
    }
  }

  return [...tags].slice(0, 12)
}

const fetchAniListMetadata = async (
  input: MetadataLookupInput,
): Promise<RemoteMetadataMatch | null> => {
  const query = `
    query ($search: String!, $type: MediaType!) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: $type) {
          id
          siteUrl
          description(asHtml: false)
          bannerImage
          seasonYear
          startDate {
            year
          }
          coverImage {
            extraLarge
            large
            medium
          }
          title {
            romaji
            english
            native
            userPreferred
          }
          genres
          tags {
            name
            rank
            isMediaSpoiler
          }
          studios(isMain: true) {
            nodes {
              name
            }
          }
          staff(perPage: 6) {
            edges {
              role
              node {
                name {
                  full
                }
              }
            }
          }
        }
      }
    }
  `

  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Orbital Library metadata cache',
    },
    body: JSON.stringify({
      query,
      variables: {
        search: input.title,
        type: input.category === 'anime' ? 'ANIME' : 'MANGA',
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`AniList request failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    data?: {
      Page?: {
        media?: AniListMedia[]
      }
    }
  }

  const media = payload.data?.Page?.media ?? []

  let bestMatch: AniListMedia | null = null
  let bestScore = 0

  for (const candidate of media) {
    const candidateTitles = [
      candidate.title.userPreferred,
      candidate.title.english,
      candidate.title.romaji,
      candidate.title.native,
    ].filter(Boolean) as string[]
    let score = scoreTitleMatch(candidateTitles, input.title, input.year)
    const candidateYear = candidate.startDate?.year ?? candidate.seasonYear ?? null

    if (input.year != null && candidateYear != null) {
      if (candidateYear === input.year) {
        score += 18
      } else if (Math.abs(candidateYear - input.year) <= 1) {
        score += 8
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestMatch = candidate
    }
  }

  if (!bestMatch || bestScore < 50) {
    return null
  }

  const topTags = bestMatch.tags
    .filter((tag) => !tag.isMediaSpoiler && tag.rank >= 60)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, 8)
    .map((tag) => tag.name)

  const firstStudio = bestMatch.studios?.nodes?.[0]?.name?.trim() || null
  const firstStaff = bestMatch.staff?.edges
    ?.find((edge) => edge.node.name.full)

  return {
    provider: 'AniList',
    providerId: String(bestMatch.id),
    description: stripHtml(bestMatch.description),
    coverImageUrl: normalizeImageUrl(
      bestMatch.coverImage?.extraLarge ||
        bestMatch.coverImage?.large ||
        bestMatch.coverImage?.medium ||
        null,
    ),
    bannerImageUrl: normalizeImageUrl(bestMatch.bannerImage),
    externalUrl: bestMatch.siteUrl || null,
    sourceName:
      input.category === 'anime'
        ? firstStudio
        : firstStaff?.node.name.full?.trim() || null,
    sourceRole:
      input.category === 'anime'
        ? firstStudio
          ? 'Studio'
          : null
        : firstStaff?.role?.trim() || 'Author',
    year: bestMatch.startDate?.year ?? bestMatch.seasonYear ?? null,
    genres: [...new Set(bestMatch.genres)].slice(0, 8),
    tags: [...new Set(topTags)],
  }
}

const fetchGoogleBooksMetadata = async (
  input: MetadataLookupInput,
): Promise<RemoteMetadataMatch | null> => {
  const queryParts = [`intitle:"${input.title}"`]
  if (input.authorHint) {
    queryParts.push(`inauthor:"${input.authorHint}"`)
  }

  const response = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(queryParts.join(' '))}&printType=books&maxResults=8`,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Orbital Library metadata cache',
      },
    },
  )

  if (!response.ok) {
    throw new Error(`Google Books request failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    items?: GoogleBooksVolume[]
  }

  const items = payload.items ?? []
  let bestMatch: GoogleBooksVolume | null = null
  let bestScore = 0

  for (const item of items) {
    const volumeInfo = item.volumeInfo
    if (!volumeInfo?.title) {
      continue
    }

    const candidateTitles = [volumeInfo.title, volumeInfo.subtitle].filter(Boolean) as string[]
    let score = scoreTitleMatch(candidateTitles, input.title, input.year)

    if (input.authorHint && volumeInfo.authors?.some((author) => normalizeTitle(author) === normalizeTitle(input.authorHint))) {
      score += 15
    }

    const candidateYear = volumeInfo.publishedDate?.match(/\d{4}/)?.[0]
    if (input.year != null && candidateYear) {
      if (Number(candidateYear) === input.year) {
        score += 10
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestMatch = item
    }
  }

  if (!bestMatch || bestScore < 45) {
    return null
  }

  const volumeInfo = bestMatch.volumeInfo || {}
  const imageLinks = volumeInfo.imageLinks || {}
  const categories = [...new Set(volumeInfo.categories || [])].slice(0, 8)
  const normalizedTags = extractGoogleBookTags(volumeInfo.categories)

  return {
    provider: 'Google Books',
    providerId: bestMatch.id,
    description: stripHtml(volumeInfo.description),
    coverImageUrl: normalizeImageUrl(
      imageLinks.extraLarge ||
        imageLinks.large ||
        imageLinks.medium ||
        imageLinks.small ||
        imageLinks.thumbnail ||
        imageLinks.smallThumbnail ||
        null,
    ),
    bannerImageUrl: null,
    externalUrl: volumeInfo.infoLink || null,
    sourceName: volumeInfo.authors?.[0]?.trim() || null,
    sourceRole: volumeInfo.authors?.length ? 'Author' : null,
    year: volumeInfo.publishedDate?.match(/\d{4}/)?.[0]
      ? Number(volumeInfo.publishedDate.match(/\d{4}/)?.[0])
      : null,
    genres: categories,
    tags: normalizedTags,
  }
}

export const fetchRemoteMetadata = async (
  input: MetadataLookupInput,
): Promise<RemoteMetadataMatch | null> => {
  if (input.category === 'anime' || input.category === 'manga') {
    return fetchAniListMetadata(input)
  }

  if (input.category === 'books') {
    return fetchGoogleBooksMetadata(input)
  }

  return null
}
