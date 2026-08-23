import type { ImgHTMLAttributes } from 'react'
import { useAuthenticatedResourceUrl } from './authenticatedResource'

type AuthenticatedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  sourceUrl: string
}

export function AuthenticatedResourceImage({
  sourceUrl,
  ...imageProps
}: AuthenticatedResourceImageProps) {
  const { url } = useAuthenticatedResourceUrl(sourceUrl)

  return <img {...imageProps} src={url || undefined} />
}
