import {
  Component,
  startTransition,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type FocusEvent,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from 'react'
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  FolderOpen,
  KeyRound,
  Languages,
  LayoutGrid,
  Library as LibraryIcon,
  List as ListIcon,
  LogOut,
  MoreVertical,
  RefreshCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import './App.css'
import { api } from './api'
import type {
  AppState,
  Bookmark,
  BootstrapState,
  CategoryId,
  EntryVariant,
  Language,
  LibraryEntry,
  ReaderProgress,
  SavedReadingPosition,
  ScanLogEntry,
  ScopeId,
  SeriesDetail,
  SeriesSummary,
  SeriesTabId,
  ViewId,
} from './appTypes'
import { categoryOrder } from './appTypes'
import { ReaderVariantMenu } from './ReaderVariantMenu'

const CbzReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.CbzReader })))
const EpubReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.EpubReader })))
const HtmlChapterReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.HtmlChapterReader })))
const PdfEmbed = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.PdfEmbed })))
const TextFileReader = lazy(() => import('./LocalFileReaders').then((module) => ({ default: module.TextFileReader })))
const VideoPlayer = lazy(() => import('./VideoPlayer').then((module) => ({ default: module.VideoPlayer })))

const emptyLibrary: SeriesSummary[] = []
const emptyMetadataReviewItems: AppState['metadataQueue'] = []
const defaultReaderCategory: CategoryId = 'books'
const readerCategoryOrder = categoryOrder.filter((category) => category !== 'anime')
const readerScopeOrder: ScopeId[] = ['all', ...readerCategoryOrder]
const isReaderCategory = (category: CategoryId) => category !== 'anime'
const resolveReaderCategory = (category: CategoryId) =>
  isReaderCategory(category) ? category : defaultReaderCategory
const sourceCategoryOptions = (currentCategory: CategoryId) =>
  [...new Set([currentCategory, ...readerCategoryOrder])]
const readerChromeInteractionSelector = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'details',
  'video',
  'audio',
  '[role="button"]',
  '.reader-overlay',
  '.document-frame__toolbar',
  '.cbz-viewer__toolbar',
  '.epub-reader__toolbar',
  '.html-reader__toolbar',
  '.variant-menu__panel',
  '.cbz-viewer__settings-menu',
].join(', ')

const isReaderChromeInteractionTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(readerChromeInteractionSelector))

const ui = {
  en: {
    brandName: 'Orbital Library',
    demoTag: 'Full stack preview',
    authEyebrow: 'Self-hosted manga, novel, and book reader',
    authTitle: 'The approved demo UI, now backed by real users, scans, and local media.',
    authBody:
      'Sign in or create an account to browse your NAS reading library, keep manual bookmarks, leave series-level comments, and let the admin mount folders for manga, novels, and books.',
    featureBookmarks: 'Bookmarks remain separated by category',
    featurePlayer: 'Series page first, then immersive reader',
    featureAdmin: 'Mounted roots, linked folders, incremental rescans',
    signIn: 'Sign in',
    createAccount: 'Create account',
    username: 'Username',
    password: 'Password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    changePassword: 'Change password',
    accountSettings: 'Account settings',
    passwordChangeHelp: 'Update your own password here. Admin resets stay available in Admin.',
    passwordChangeSuccess: 'Password updated.',
    passwordMismatch: 'New password and confirmation do not match.',
    authAction: 'Open library',
    adminBootstrap: 'Reserved bootstrap admin',
    searchPlaceholder: 'Search every shelf, series, and file',
    scopes: {
      all: 'All media',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazines',
      books: 'Books',
    },
    nav: {
      bookmarks: 'Bookmarks',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazines',
      books: 'Books',
    },
    mobileNav: {
      library: 'Library',
      discover: 'Discover',
      search: 'Search',
      profile: 'Profile',
    },
    profile: 'Profile',
    admin: 'Admin',
    profileMenu: 'Settings',
    librarySort: 'Last read',
    sortBy: 'Sort by',
    sortTitle: 'Name',
    sortYear: 'Year',
    viewMode: 'View',
    gridView: 'Grid',
    listView: 'List',
    accountActions: 'Account',
    adminTools: 'Admin tools',
    quickResults: 'Quick results',
    searchTitle: 'Search',
    searchEmpty: 'Type to search your whole library.',
    searchNoMatches: 'No matches yet.',
    searching: 'Searching...',
    searchAction: 'Search',
    clearSearch: 'Clear',
    closeSearch: 'Close search',
    filters: 'Filters',
    activeFilter: 'Active filter',
    clearFilter: 'Clear filter',
    closeFilters: 'Close filters',
    moreMenu: 'More',
    welcome: 'Bookmarks',
    bookmarksHero: 'Continue by category',
    bookmarksHome: 'Default home',
    bookmarksBody:
      'Each signed-in user lands on category-separated bookmarks first so resuming feels immediate on desktop, tablet, and phone.',
    overview: 'Overview',
    entries: 'Entries',
    comments: 'Comments',
    entryLabel: 'Label',
    entryTitle: 'Title',
    entryDetails: 'Details',
    entryAction: 'Action',
    resume: 'Resume',
    openSeries: 'Open series',
    bookmarkActions: 'Bookmark actions',
    removeBookmark: 'Remove bookmark',
    openReader: 'Open reader',
    previousEntry: 'Previous chapter',
    previousEntryShort: 'Prev',
    nextEntry: 'Next chapter',
    nextEntryShort: 'Next',
    setBookmark: 'Set bookmark',
    setBookmarkShort: 'Bookmark',
    bookmarked: 'Bookmarked',
    bookmarkedShort: 'Saved',
    backToList: 'Back to list',
    libraryTitle: 'Shelf browsing',
    libraryBody:
      'Cover-first cards, compact metadata, and search that can span every linked folder or just one category.',
    seriesActions: 'Series actions',
    localCover: 'Cover source',
    onlineMatch: 'Metadata source',
    lastScan: 'Last scan',
    scanMode: 'Incremental scan',
    sourceRoots: 'Mounted roots',
    sourceFolders: 'Linked folders',
    addMediaFolder: 'Import media',
    addMediaFolderBody: 'Add one folder to the library in three steps. Existing imports stay editable below.',
    importStepType: 'Type',
    importStepFolder: 'Folder',
    importStepReview: 'Review',
    importTypeTitle: 'What are you adding?',
    importTypeBody: 'Pick the library section this folder should appear in. You can change this later.',
    importFolderTitle: 'Choose the folder',
    importFolderBody: 'Browse your mounted archive, then continue to review.',
    importReviewTitle: 'Ready to import',
    importReviewBody: 'This folder will be added to the selected section and scanned immediately.',
    importNextFolder: 'Choose folder',
    importReviewAction: 'Review import',
    importBack: 'Back',
    importChange: 'Change',
    importStorage: 'Storage',
    importStorageDetails: 'Storage details',
    importCurrentPath: 'Current path',
    importExistingTitle: 'Current imports',
    importExistingEmpty: 'No media folders linked yet.',
    importAlreadyLinkedHelp: 'This folder is already linked. Use Current imports to rescan or move it.',
    importOpenFolderFirst: 'Open a folder before reviewing the import.',
    importMainArchive: 'Main archive',
    importDockerRoot: 'Docker media root',
    folderCategory: 'Media type',
    folderLocation: 'Folder location',
    selectedFolder: 'Selected folder',
    selectedRootFolder: 'Root folder',
    addAndScanFolder: 'Add folder and scan',
    folderAlreadyLinked: 'Already added',
    openFolder: 'Open',
    folderPathInput: 'Paste folder path',
    folderPathPlaceholder: './library/books or media/books',
    useFolderPath: 'Go to folder',
    linkedMediaFolders: 'Media folders',
    changeFolderCategory: 'Move to',
    rescanFolder: 'Rescan folder',
    advancedRoots: 'Advanced mounted roots',
    folderBrowserEmpty: 'No folders inside this location.',
    nativePickerUnavailable:
      'Native Windows folder pickers cannot pass host paths into a Docker web app, so this browser shows folders that are already mounted into the container.',
    folderPathOutsideRoot: 'That folder is outside the selected mounted root.',
    scanChanges: 'Scan now',
    refreshMetadata: 'Rescan all',
    users: 'User accounts',
    resetPassword: 'Reset password',
    unlinkFolder: 'Unlink folder',
    unlinkRoot: 'Unmount root',
    metadataQueue: 'Metadata queue',
    metadataReview: 'Metadata review',
    metadataEditor: 'Metadata editor',
    metadataSearchPlaceholder: 'Find a series to edit metadata',
    metadataReason: 'Review reason',
    metadataCurrentState: 'Current state',
    metadataOverrideTitle: 'Override title',
    metadataOverrideYear: 'Override year',
    metadataOverrideDescription: 'Override description',
    metadataOverrideSourceName: 'Override source name',
    metadataOverrideSourceRole: 'Override source role',
    metadataOverrideExternalUrl: 'Override source URL',
    metadataOverrideCoverUrl: 'Override cover image URL',
    metadataSave: 'Save override',
    metadataClear: 'Clear override',
    metadataRefresh: 'Refresh match',
    metadataOpenSeries: 'Open series page',
    metadataNoItems: 'No review items right now.',
    metadataNoSelection: 'Pick a review item or search for any series to edit its metadata.',
    synopsis: 'Synopsis',
    genres: 'Genres',
    sourceDetails: 'Source details',
    creatorProfile: 'Creator profile',
    creatorWorks: 'Works in library',
    creatorCategories: 'Categories',
    openCreatorPage: 'Open creator page',
    moreFromCreator: 'More from this creator',
    noRelatedCreatorTitles: 'No other linked titles from this creator yet.',
    libraryDetails: 'Library details',
    sourceLabel: 'Source',
    sourceRole: 'Role',
    booksTopics: 'Book topics',
    allTopics: 'All topics',
    openSourcePage: 'Open source page',
    scanActivity: 'Scan activity',
    scanProgress: 'Progress',
    linkedFolderProgress: 'Linked folders',
    filesDiscovered: 'Files discovered',
    detectedSeries: 'Detected series',
    indexedSeries: 'Indexed series',
    currentSource: 'Current source',
    currentSeries: 'Current series',
    scanLogEmpty: 'No scan events yet.',
    scanInProgress: 'Scan in progress',
    scanIdle: 'No active scan right now.',
    scanRawLog: 'Raw event log',
    scanRawLogHelp: 'Browser and server scan events, shown as reported.',
    scanRawLogEmpty: 'No raw scan lines yet. Start a scan to stream events here.',
    scanStartQueued: 'Browser requested a scan start; waiting for server status.',
    scanRequestLost: 'Browser request failed, but the scan may still be running. Polling server status',
    commentsEmpty: 'No comments yet.',
    language: 'Language',
    searchCount: 'matches',
    searchHint:
      'Search checks series titles, paths, and entry names. Keep it global by default or narrow to one category when you need to.',
    loading: 'Loading library...',
    loadingSeries: 'Loading series...',
    addComment: 'Add comment',
    commentPlaceholder: 'Leave a series-level comment for other users in your home network.',
    postComment: 'Post comment',
    mountedRootLabel: 'Mounted root label',
    mountedRootPath: 'Mounted root path',
    addMountedRoot: 'Add mounted root',
    configuredRootHelp:
      'Docker-mounted roots appear here automatically. Use the form only for extra paths that already exist inside the container.',
    configuredRootLocked: 'This root comes from your Docker setup.',
    browseFolders: 'Browse linked root',
    linkCurrentFolder: 'Link current folder',
    currentFolder: 'Current folder',
    browseUp: 'Up one folder',
    categoryToLink: 'Category to link',
    resetPasswordPrompt: 'Enter a new password for this user',
    logout: 'Log out',
    noLibrary: 'No linked media yet. Add a mounted root and link category folders in the admin page.',
    scanReady: 'Ready',
    openOriginal: 'Open original file',
    authErrorFallback: 'Unable to reach the server right now.',
  },
  de: {
    brandName: 'Orbital Library',
    demoTag: 'Full-Stack-Vorschau',
    authEyebrow: 'Selbst gehosteter Manga-, Novel- und Buch-Reader',
    authTitle: 'Die bestätigte Demo-Oberfläche, jetzt mit echten Nutzern, Scans und lokalen Medien.',
    authBody:
      'Melde dich an oder erstelle einen Account, um deine NAS-Lesebibliothek zu durchsuchen, manuelle Lesezeichen zu setzen, Kommentare zu hinterlassen und als Admin Ordner für Manga, Novels und Bücher zu verknüpfen.',
    featureBookmarks: 'Lesezeichen bleiben nach Kategorien getrennt',
    featurePlayer: 'Serienseite zuerst, dann immersiver Reader',
    featureAdmin: 'Eingehängte Wurzeln, verknüpfte Ordner, inkrementelle Rescans',
    signIn: 'Anmelden',
    createAccount: 'Account erstellen',
    username: 'Benutzername',
    password: 'Passwort',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirmPassword: 'Passwort bestätigen',
    changePassword: 'Passwort ändern',
    accountSettings: 'Kontoeinstellungen',
    passwordChangeHelp: 'Hier kannst du dein eigenes Passwort ändern. Admin-Resets bleiben im Admin-Bereich.',
    passwordChangeSuccess: 'Passwort aktualisiert.',
    passwordMismatch: 'Neues Passwort und Bestätigung stimmen nicht überein.',
    authAction: 'Bibliothek öffnen',
    adminBootstrap: 'Reservierter Bootstrap-Admin',
    searchPlaceholder: 'Alle Regale, Serien und Dateien durchsuchen',
    scopes: {
      all: 'Alle Medien',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazine',
      books: 'Bücher',
    },
    nav: {
      bookmarks: 'Lesezeichen',
      anime: 'Anime',
      manga: 'Manga',
      novels: 'Novels',
      magazines: 'Magazine',
      books: 'Bücher',
    },
    mobileNav: {
      library: 'Bibliothek',
      discover: 'Entdecken',
      search: 'Suche',
      profile: 'Profil',
    },
    profile: 'Profil',
    admin: 'Admin',
    profileMenu: 'Einstellungen',
    librarySort: 'Zuletzt gelesen',
    sortBy: 'Sortieren',
    sortTitle: 'Name',
    sortYear: 'Jahr',
    viewMode: 'Ansicht',
    gridView: 'Raster',
    listView: 'Liste',
    accountActions: 'Account',
    adminTools: 'Admin-Werkzeuge',
    quickResults: 'Schnellergebnisse',
    searchTitle: 'Suche',
    searchEmpty: 'Tippe, um deine gesamte Bibliothek zu durchsuchen.',
    searchNoMatches: 'Noch keine Treffer.',
    searching: 'Suche...',
    searchAction: 'Suche',
    clearSearch: 'Leeren',
    closeSearch: 'Suche schlieÃŸen',
    filters: 'Filter',
    activeFilter: 'Aktiver Filter',
    clearFilter: 'Filter lÃ¶schen',
    closeFilters: 'Filter schlieÃŸen',
    moreMenu: 'Mehr',
    welcome: 'Lesezeichen',
    bookmarksHero: 'Nach Kategorie fortsetzen',
    bookmarksHome: 'Standard-Startseite',
    bookmarksBody:
      'Jeder eingeloggte Nutzer landet zuerst auf getrennten Lesezeichen pro Kategorie, damit das Fortsetzen auf Desktop, Tablet und Handy sofort klappt.',
    overview: 'Übersicht',
    entries: 'Einträge',
    comments: 'Kommentare',
    entryLabel: 'Label',
    entryTitle: 'Titel',
    entryDetails: 'Details',
    entryAction: 'Aktion',
    resume: 'Fortsetzen',
    bookmarkActions: 'Lesezeichen-Aktionen',
    removeBookmark: 'Lesezeichen entfernen',
    openSeries: 'Serie öffnen',
    openReader: 'Reader öffnen',
    previousEntry: 'Vorheriges Kapitel',
    previousEntryShort: 'Zur',
    nextEntry: 'Nächstes Kapitel',
    nextEntryShort: 'Vor',
    setBookmark: 'Lesezeichen setzen',
    setBookmarkShort: 'Merken',
    bookmarked: 'Gespeichert',
    bookmarkedShort: 'Gespeichert',
    backToList: 'Zur Liste',
    libraryTitle: 'Regalansicht',
    libraryBody:
      'Cover-zentrierte Karten, kompakte Metadaten und eine Suche, die über alle verknüpften Ordner oder nur eine Kategorie gehen kann.',
    seriesActions: 'Serienaktionen',
    localCover: 'Cover-Quelle',
    onlineMatch: 'Metadaten-Quelle',
    lastScan: 'Letzter Scan',
    scanMode: 'Inkrementeller Scan',
    sourceRoots: 'Eingehängte Wurzeln',
    sourceFolders: 'Verknüpfte Ordner',
    addMediaFolder: 'Medien importieren',
    addMediaFolderBody: 'Fuege einen Ordner in drei Schritten zur Bibliothek hinzu. Bestehende Importe bleiben unten editierbar.',
    importStepType: 'Typ',
    importStepFolder: 'Ordner',
    importStepReview: 'Pruefen',
    importTypeTitle: 'Was fuegst du hinzu?',
    importTypeBody: 'Waehle den Bibliotheksbereich fuer diesen Ordner. Du kannst das spaeter aendern.',
    importFolderTitle: 'Ordner waehlen',
    importFolderBody: 'Durchsuche dein eingebundenes Archiv und pruefe danach den Import.',
    importReviewTitle: 'Bereit zum Import',
    importReviewBody: 'Dieser Ordner wird zum gewaehlten Bereich hinzugefuegt und direkt gescannt.',
    importNextFolder: 'Ordner waehlen',
    importReviewAction: 'Import pruefen',
    importBack: 'Zurueck',
    importChange: 'Aendern',
    importStorage: 'Speicherort',
    importStorageDetails: 'Speicher-Details',
    importCurrentPath: 'Aktueller Pfad',
    importExistingTitle: 'Aktuelle Importe',
    importExistingEmpty: 'Noch keine Medienordner verknuepft.',
    importAlreadyLinkedHelp: 'Dieser Ordner ist bereits verknuepft. Nutze Aktuelle Importe zum Scannen oder Verschieben.',
    importOpenFolderFirst: 'Oeffne zuerst einen Ordner, bevor du den Import pruefst.',
    importMainArchive: 'Hauptarchiv',
    importDockerRoot: 'Docker-Medienwurzel',
    folderCategory: 'Medientyp',
    folderLocation: 'Ordnerort',
    selectedFolder: 'Ausgewaehlter Ordner',
    selectedRootFolder: 'Wurzelordner',
    addAndScanFolder: 'Ordner hinzufuegen und scannen',
    folderAlreadyLinked: 'Schon hinzugefuegt',
    openFolder: 'Oeffnen',
    folderPathInput: 'Ordnerpfad einfuegen',
    folderPathPlaceholder: './library/books oder media/books',
    useFolderPath: 'Zum Ordner',
    linkedMediaFolders: 'Medienordner',
    changeFolderCategory: 'Verschieben nach',
    rescanFolder: 'Ordner scannen',
    advancedRoots: 'Erweiterte Wurzeln',
    folderBrowserEmpty: 'Keine Ordner an diesem Ort.',
    nativePickerUnavailable:
      'Native Windows-Ordnerdialoge koennen keine Host-Pfade in eine Docker-Web-App uebergeben. Dieser Browser zeigt Ordner, die bereits im Container eingebunden sind.',
    folderPathOutsideRoot: 'Dieser Ordner liegt ausserhalb der ausgewaehlten Wurzel.',
    scanChanges: 'Jetzt scannen',
    refreshMetadata: 'Alles rescannen',
    users: 'Benutzerkonten',
    resetPassword: 'Passwort zurücksetzen',
    unlinkFolder: 'Ordner trennen',
    unlinkRoot: 'Wurzel aushängen',
    metadataQueue: 'Metadaten-Warteschlange',
    metadataReview: 'Metadaten-Prüfung',
    metadataEditor: 'Metadaten-Editor',
    metadataSearchPlaceholder: 'Serie für Metadatenbearbeitung finden',
    metadataReason: 'Prüfgrund',
    metadataCurrentState: 'Aktueller Stand',
    metadataOverrideTitle: 'Titel überschreiben',
    metadataOverrideYear: 'Jahr überschreiben',
    metadataOverrideDescription: 'Beschreibung überschreiben',
    metadataOverrideSourceName: 'Quellnamen überschreiben',
    metadataOverrideSourceRole: 'Quellrolle überschreiben',
    metadataOverrideExternalUrl: 'Quell-URL überschreiben',
    metadataOverrideCoverUrl: 'Cover-Bild-URL überschreiben',
    metadataSave: 'Override speichern',
    metadataClear: 'Override löschen',
    metadataRefresh: 'Match aktualisieren',
    metadataOpenSeries: 'Serienseite öffnen',
    metadataNoItems: 'Aktuell keine Review-Einträge.',
    metadataNoSelection: 'Wähle einen Review-Eintrag oder suche eine Serie, um ihre Metadaten zu bearbeiten.',
    synopsis: 'Inhalt',
    genres: 'Genres',
    sourceDetails: 'Quellinfos',
    creatorProfile: 'Creator-Profil',
    creatorWorks: 'Werke in der Bibliothek',
    creatorCategories: 'Kategorien',
    openCreatorPage: 'Creator-Profil öffnen',
    moreFromCreator: 'Mehr von dieser Quelle',
    noRelatedCreatorTitles: 'Noch keine weiteren verknüpften Titel von dieser Quelle.',
    libraryDetails: 'Bibliotheksinfos',
    sourceLabel: 'Quelle',
    sourceRole: 'Rolle',
    booksTopics: 'Buchthemen',
    allTopics: 'Alle Themen',
    openSourcePage: 'Quellseite öffnen',
    scanActivity: 'Scan-Aktivität',
    scanProgress: 'Fortschritt',
    linkedFolderProgress: 'Verknüpfte Ordner',
    filesDiscovered: 'Gefundene Dateien',
    detectedSeries: 'Erkannte Serien',
    indexedSeries: 'Indizierte Serien',
    currentSource: 'Aktuelle Quelle',
    currentSeries: 'Aktuelle Serie',
    scanLogEmpty: 'Noch keine Scan-Ereignisse.',
    scanInProgress: 'Scan läuft',
    scanIdle: 'Aktuell läuft kein Scan.',
    scanRawLog: 'Roh-Log',
    scanRawLogHelp: 'Browser- und Server-Scanereignisse, direkt aus dem Status.',
    scanRawLogEmpty: 'Noch keine Rohzeilen. Starte einen Scan, um Events hier zu sehen.',
    scanStartQueued: 'Browser hat den Scan-Start angefragt; warte auf Serverstatus.',
    scanRequestLost: 'Browser-Request fehlgeschlagen, aber der Scan kann trotzdem laufen. Serverstatus wird weiter abgefragt',
    commentsEmpty: 'Noch keine Kommentare.',
    language: 'Sprache',
    searchCount: 'Treffer',
    searchHint:
      'Die Suche prüft Serientitel, Pfade und Eintragsnamen. Standardmäßig bleibt sie global oder du grenzt sie auf eine Kategorie ein.',
    loading: 'Bibliothek wird geladen...',
    loadingSeries: 'Serie wird geladen...',
    addComment: 'Kommentar hinzufügen',
    commentPlaceholder: 'Hinterlasse einen Kommentar auf Serienebene für andere Nutzer in deinem Heimnetz.',
    postComment: 'Kommentar senden',
    mountedRootLabel: 'Name der eingebundenen Wurzel',
    mountedRootPath: 'Pfad der eingebundenen Wurzel',
    addMountedRoot: 'Eingebundene Wurzel hinzufügen',
    browseFolders: 'Verknüpfte Wurzel durchsuchen',
    linkCurrentFolder: 'Aktuellen Ordner verknüpfen',
    currentFolder: 'Aktueller Ordner',
    browseUp: 'Eine Ebene hoch',
    categoryToLink: 'Kategorie zum Verknüpfen',
    resetPasswordPrompt: 'Neues Passwort für diesen Nutzer eingeben',
    logout: 'Abmelden',
    noLibrary: 'Noch keine Medien verknüpft. Füge im Admin-Bereich zuerst Wurzeln und Kategorie-Ordner hinzu.',
    scanReady: 'Bereit',
    openOriginal: 'Originaldatei öffnen',
    authErrorFallback: 'Der Server ist gerade nicht erreichbar.',
    configuredRootHelp:
      'Von Docker bereitgestellte Wurzeln erscheinen hier automatisch. Das Formular brauchst du nur fuer zusaetzliche Pfade, die im Container bereits sichtbar sind.',
    configuredRootLocked: 'Diese Wurzel stammt aus deinem Docker-Setup.',
  },
} as const

const posterColors: Record<CategoryId, [string, string]> = {
  anime: ['#2346a3', '#5fe2ff'],
  manga: ['#5b74ff', '#52dbc6'],
  novels: ['#2b966f', '#8ae6b4'],
  books: ['#a56dff', '#ffd27a'],
  magazines: ['#c66b4a', '#ffd07c'],
}

type AppIconName =
  | 'library'
  | 'discover'
  | 'search'
  | 'profile'
  | 'read'
  | 'settings'
  | 'key'
  | 'admin'
  | 'logout'
  | 'language'
  | 'chevronRight'
  | 'close'
  | 'more'
  | 'back'
  | 'up'
  | 'folder'
  | 'refresh'
  | 'check'
  | 'grid'
  | 'list'
  | 'filter'

const appIconComponents: Record<AppIconName, LucideIcon> = {
  admin: ShieldCheck,
  back: ArrowLeft,
  check: Check,
  chevronRight: ChevronRight,
  close: X,
  discover: Compass,
  filter: SlidersHorizontal,
  folder: FolderOpen,
  grid: LayoutGrid,
  key: KeyRound,
  language: Languages,
  library: LibraryIcon,
  list: ListIcon,
  logout: LogOut,
  more: MoreVertical,
  profile: UserRound,
  read: BookOpen,
  refresh: RefreshCw,
  search: SearchIcon,
  settings: SettingsIcon,
  up: ArrowUp,
}

const AppIcon = ({ className = '', name }: { className?: string; name: AppIconName }) => {
  const Icon = appIconComponents[name]

  return (
    <Icon
      aria-hidden="true"
      className={className ? `app-icon ${className}` : 'app-icon'}
      focusable="false"
      strokeWidth={1.9}
    />
  )
}

type CreatorProfile = {
  key: string
  name: string
  role: string | null
  categories: CategoryId[]
  series: SeriesSummary[]
}

type MountedRootSummary = AppState['sourceRoots'][number]
type ImportStepId = 'type' | 'folder' | 'review'

const normalizeFolderInput = (value: string) =>
  value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')

const joinMountedDisplayPath = (basePath: string, relativePath: string) => {
  if (!relativePath) {
    return basePath
  }

  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  const normalizedBase = basePath.replace(/[\\/]+$/, '')
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '')

  return `${normalizedBase}${separator}${normalizedRelative}`
}

const resolveRelativeFolderInput = (value: string, root: MountedRootSummary) => {
  const normalizedValue = normalizeFolderInput(value)
  const normalizedRoot = normalizeFolderInput(root.path)

  if (!normalizedValue) {
    return ''
  }

  const comparableValue = normalizedValue.toLowerCase()
  const comparableRoot = normalizedRoot.toLowerCase()

  if (comparableValue === comparableRoot) {
    return ''
  }

  if (comparableRoot && comparableValue.startsWith(`${comparableRoot}/`)) {
    return normalizedValue.slice(normalizedRoot.length + 1).replace(/^\/+/, '')
  }

  if (/^[a-z]:\//i.test(normalizedValue) || normalizedValue.startsWith('/')) {
    return null
  }

  return normalizedValue.replace(/^\/+/, '')
}

const getFolderLeafLabel = (relativePath: string) => {
  const segments = relativePath.split('/').filter(Boolean)
  return segments[segments.length - 1] || '/'
}

const formatRelativeTime = (value: string | null, language: Language) => {
  if (!value) {
    return language === 'de' ? 'Noch nicht gescannt' : 'Not scanned yet'
  }

  const target = new Date(value)
  const diffMs = target.getTime() - Date.now()
  const minutes = Math.round(diffMs / 60000)
  const rtf = new Intl.RelativeTimeFormat(language === 'de' ? 'de-DE' : 'en-US', {
    numeric: 'auto',
  })

  if (Math.abs(minutes) < 60) {
    return rtf.format(minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48) {
    return rtf.format(hours, 'hour')
  }

  const days = Math.round(hours / 24)
  return rtf.format(days, 'day')
}

const formatDateTime = (value: string | null, language: Language) => {
  if (!value) {
    return language === 'de' ? 'Noch nicht' : 'Not yet'
  }

  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

const formatCountLabel = (category: CategoryId, count: number, language: Language) => {
  if (language === 'de') {
    if (category === 'anime') return `${count} ${count === 1 ? 'Episode' : 'Episoden'}`
    if (category === 'manga') return `${count} ${count === 1 ? 'Band' : 'Bände'}`
    if (category === 'novels') return `${count} ${count === 1 ? 'Kapitel' : 'Kapitel'}`
    if (category === 'magazines') return `${count} ${count === 1 ? 'Ausgabe' : 'Ausgaben'}`
    return `${count} ${count === 1 ? 'Datei' : 'Dateien'}`
  }

  if (category === 'anime') return `${count} ${count === 1 ? 'episode' : 'episodes'}`
  if (category === 'manga') return `${count} ${count === 1 ? 'volume' : 'volumes'}`
  if (category === 'novels') return `${count} ${count === 1 ? 'chapter' : 'chapters'}`
  if (category === 'magazines') return `${count} ${count === 1 ? 'issue' : 'issues'}`
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

const buildReaderLocation = (
  category: CategoryId,
  progress: ReaderProgress,
  entryLabel: string,
) => {
  if (progress.locationType === 'percent' && progress.progressLabel && progress.cueLabel) {
    return {
      progress: progress.progressLabel,
      cue: progress.cueLabel,
    }
  }

  if (category === 'manga' && progress.viewMode === 'spread') {
    const spreadEnd =
      progress.endPage ?? (progress.page === 1 ? 1 : Math.min(progress.page + 1, progress.totalPages))
    const rangeLabel =
      spreadEnd === progress.page ? `Page ${progress.page}` : `Pages ${progress.page}-${spreadEnd}`

    return {
      progress: `${rangeLabel} of ${progress.totalPages}`,
      cue: `Bookmark set at ${rangeLabel.toLowerCase()} in spread mode`,
    }
  }

  if (category === 'anime') {
    return {
      progress: entryLabel,
      cue: `Bookmark set on ${entryLabel}`,
    }
  }

  return {
    progress: `Page ${progress.page} of ${progress.totalPages}`,
    cue: `Bookmark set at page ${progress.page}`,
  }
}

const savedPositionToReaderProgress = (
  position: SavedReadingPosition | null | undefined,
): ReaderProgress | null => {
  if (!position) {
    return null
  }

  return {
    page: position.page,
    totalPages: position.totalPages ?? 1,
    viewMode: position.viewMode,
    locationType: position.locationType,
    progressLabel: position.progressLabel,
    cueLabel: position.cueLabel,
  }
}

const firstSeriesId = (state: AppState | null) =>
  state?.library.find((series) => isReaderCategory(series.category))?.id || state?.library[0]?.id || null

class ReaderErrorBoundary extends Component<
  { children: ReactNode; fallback: (message: string | null) => ReactNode; resetKey: string },
  { message: string | null }
> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : 'The reader hit a browser rendering issue.',
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Reader crashed', error, info.componentStack)
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null })
    }
  }

  render() {
    if (this.state.message) {
      return this.props.fallback(this.state.message)
    }

    return this.props.children
  }
}

const genericLocalTags = new Set([
  'Local library',
  'Plex scan',
  'Local archive',
  'Reader ready',
  'Local text library',
  'Responsive reader',
  'Local book',
])

const formatDisplayEntryTitle = (title: string) => {
  const trimmedTitle = title.trim()
  const cleanedTitle = trimmedTitle.replace(
    /^(?:chapter|ch|volume|vol(?:ume)?|episode|ep|book)\s*\d+(?:\.\d+)?(?:\s*[:._-]\s*|\s+)+/i,
    '',
  ).trim()

  return cleanedTitle || trimmedTitle
}

const getBookmarkProgressHint = (bookmark: Bookmark) => {
  const progress = bookmark.progress.trim()

  if (!progress) {
    return null
  }

  if (progress === bookmark.entryLabel) {
    return null
  }

  if (/^(?:chapter|book)\s+start$/i.test(progress)) {
    return null
  }

  return progress
}

const shouldUseEntryBookmarkProgress = (category: CategoryId) =>
  category === 'manga' || category === 'novels' || category === 'magazines'

const getBookmarkEntryLabel = (category: CategoryId, language: Language) => {
  if (language === 'de') {
    return category === 'magazines' ? 'Ausgabe' : 'Kapitel'
  }

  return category === 'magazines' ? 'Issue' : 'Chapter'
}

const getBookmarkEntryUnit = (category: CategoryId, count: number, language: Language) => {
  if (language === 'de') {
    return category === 'magazines' ? (count === 1 ? 'Ausgabe' : 'Ausgaben') : 'Kapitel'
  }

  if (category === 'magazines') {
    return count === 1 ? 'issue' : 'issues'
  }

  return count === 1 ? 'chapter' : 'chapters'
}

const formatBookmarkRemaining = (category: CategoryId, remaining: number, language: Language) => {
  if (remaining <= 0) {
    return language === 'de' ? 'Abgeschlossen' : 'Complete'
  }

  const unit = getBookmarkEntryUnit(category, remaining, language)
  return language === 'de' ? `${remaining} ${unit} übrig` : `${remaining} ${unit} left`
}

const formatSeasonLabel = (seasonNumber: number, language: Language) => {
  if (seasonNumber === 0) {
    return language === 'de' ? 'Specials' : 'Specials'
  }

  return language === 'de' ? `Staffel ${seasonNumber}` : `Season ${seasonNumber}`
}

const getVisibleSeriesTags = (series: SeriesSummary) => {
  const filteredTags =
    series.metadataSource === 'Folder-derived metadata'
      ? series.tags
      : series.tags.filter((tag) => !genericLocalTags.has(tag))

  return filteredTags.slice(0, 8)
}

const normalizeBrowseToken = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

const getSeriesTopicTags = (series: SeriesSummary) => {
  const visibleTags = getVisibleSeriesTags(series)
  const combined = [...visibleTags, ...series.genres]
  const deduped = new Set<string>()
  const localAuthorHint =
    series.category === 'books'
      ? series.description.match(/^Local book file by (.+?)(?:\.)?$/i)?.[1]?.trim() || ''
      : ''
  const normalizedSourceNames = [series.sourceName || '', localAuthorHint]
    .map((value) => normalizeBrowseToken(value))
    .filter(Boolean)

  for (const tag of combined) {
    const normalizedTag = tag.trim()
    if (!normalizedTag) {
      continue
    }

    const normalizedTagKey = normalizeBrowseToken(normalizedTag)
    const normalizedTagTokens = normalizedTagKey.split('-').filter(Boolean)
    const matchesKnownSourceName = normalizedSourceNames.some((sourceName) => {
      if (
        normalizedTagKey === sourceName ||
        normalizedTagKey.includes(sourceName) ||
        sourceName.includes(normalizedTagKey)
      ) {
        return true
      }

      const sourceTokens = sourceName.split('-').filter(Boolean)
      return sourceTokens.length > 0 && sourceTokens.every((token) => normalizedTagTokens.includes(token))
    })

    if (
      genericLocalTags.has(normalizedTag) ||
      matchesKnownSourceName
    ) {
      continue
    }

    deduped.add(normalizedTag)
  }

  return [...deduped]
}

const getSeriesSourceText = (series: SeriesSummary) => {
  if (series.sourceName) {
    return series.sourceRole ? `${series.sourceRole}: ${series.sourceName}` : series.sourceName
  }

  return series.metadataSource
}

const getSeriesDisplayTitle = (series: SeriesSummary) => {
  const folderLeaf = series.folder.split(/[\\/]/).filter(Boolean).pop() || ''

  return (
    series.title.trim() ||
    series.titleShort.trim() ||
    folderLeaf.trim() ||
    series.format.trim() ||
    'Untitled'
  )
}

const getAvailableAnimeSeasons = (series: SeriesDetail | null) => {
  if (!series || series.category !== 'anime') {
    return []
  }

  return [...new Set(series.entries.map((entry) => entry.seasonNumber).filter((seasonNumber): seasonNumber is number => seasonNumber != null))].sort(
    (left, right) => left - right,
  )
}

const findEntrySelection = (
  series: SeriesDetail | null,
  targetId?: string | null,
): { entry: LibraryEntry; variant: EntryVariant } | null => {
  if (!series?.entries.length) {
    return null
  }

  const resolvePreferredVariant = (entry: LibraryEntry) =>
    entry.variants.find((variant) => variant.id === entry.preferredVariantId) || entry.variants[0]

  if (!targetId) {
    const firstEntry = series.entries[0]
    const preferredVariant = resolvePreferredVariant(firstEntry)

    return preferredVariant ? { entry: firstEntry, variant: preferredVariant } : null
  }

  for (const entry of series.entries) {
    if (entry.id === targetId) {
      const preferredVariant = resolvePreferredVariant(entry)
      return preferredVariant ? { entry, variant: preferredVariant } : null
    }

    const matchedVariant = entry.variants.find((variant) => variant.id === targetId)
    if (matchedVariant) {
      return { entry, variant: matchedVariant }
    }
  }

  const firstEntry = series.entries[0]
  const preferredVariant = resolvePreferredVariant(firstEntry)

  return preferredVariant ? { entry: firstEntry, variant: preferredVariant } : null
}

function App() {
  const [language, setLanguage] = useState<Language>('en')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [bootLoading, setBootLoading] = useState(true)
  const [stateLoading, setStateLoading] = useState(true)
  const [stateError, setStateError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false)
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null)
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState<string | null>(null)
  const [currentView, setCurrentView] = useState<ViewId>('bookmarks')
  const [currentCategory, setCurrentCategory] = useState<CategoryId>(defaultReaderCategory)
  const [bookmarkFilter, setBookmarkFilter] = useState<ScopeId>('all')
  const [openBookmarkMenuKey, setOpenBookmarkMenuKey] = useState<string | null>(null)
  const [removingBookmarkSeriesId, setRemovingBookmarkSeriesId] = useState<string | null>(null)
  const [bookTopicFilters, setBookTopicFilters] = useState<string[]>([])
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null)
  const [selectedCreatorKey, setSelectedCreatorKey] = useState<string | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<SeriesTabId>('entries')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchScope, setSearchScope] = useState<ScopeId>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState<SeriesSummary[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [topbarHidden, setTopbarHidden] = useState(false)
  const [discoverSort, setDiscoverSort] = useState<'title' | 'year'>('title')
  const [discoverViewMode, setDiscoverViewMode] = useState<'grid' | 'list'>('grid')
  const [seriesCache, setSeriesCache] = useState<Record<string, SeriesDetail>>({})
  const [seriesLoadingId, setSeriesLoadingId] = useState<string | null>(null)
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [readerProgress, setReaderProgress] = useState<ReaderProgress | null>(null)
  const [readerResumePosition, setReaderResumePosition] =
    useState<SavedReadingPosition | null>(null)
  const [readerResumeVariantId, setReaderResumeVariantId] = useState<string | null>(null)
  const [bookmarkJustSet, setBookmarkJustSet] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [rootLabel, setRootLabel] = useState('Media root')
  const [rootPath, setRootPath] = useState('')
  const [adminBusy, setAdminBusy] = useState(false)
  const [scanClientNotice, setScanClientNotice] = useState<ScanLogEntry | null>(null)
  const [scanPollUntil, setScanPollUntil] = useState<number | null>(null)
  const [metadataSearchQuery, setMetadataSearchQuery] = useState('')
  const [selectedMetadataSeriesId, setSelectedMetadataSeriesId] = useState<string | null>(null)
  const [metadataTitleDraft, setMetadataTitleDraft] = useState('')
  const [metadataYearDraft, setMetadataYearDraft] = useState('')
  const [metadataDescriptionDraft, setMetadataDescriptionDraft] = useState('')
  const [metadataSourceNameDraft, setMetadataSourceNameDraft] = useState('')
  const [metadataSourceRoleDraft, setMetadataSourceRoleDraft] = useState('')
  const [metadataExternalUrlDraft, setMetadataExternalUrlDraft] = useState('')
  const [metadataCoverUrlDraft, setMetadataCoverUrlDraft] = useState('')
  const [selectedRootId, setSelectedRootId] = useState<string>('')
  const [browsePath, setBrowsePath] = useState('')
  const [browseCategory, setBrowseCategory] = useState<CategoryId>('books')
  const [manualFolderPath, setManualFolderPath] = useState('')
  const [importStep, setImportStep] = useState<ImportStepId>('type')
  const [directoryListing, setDirectoryListing] = useState<{
    currentPath: string
    directories: Array<{ name: string; relativePath: string }>
  }>({
    currentPath: '',
    directories: [],
  })
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null)
  const lastScrollYRef = useRef(0)
  const lastAutoSaveKeyRef = useRef<string | null>(null)
  const readerTouchStartRef = useRef<{ edge: 'left' | 'right' | null; x: number; y: number } | null>(null)
  const lastReaderTouchToggleRef = useRef(0)
  const readerChromeTimerRef = useRef<number | null>(null)
  const [readerChromeVisible, setReaderChromeVisible] = useState(true)

  const text = ui[language]
  const deferredSearch = useDeferredValue(searchQuery.trim())
  const sessionUser = appState?.user ?? bootstrapState?.user ?? null
  const authenticated = Boolean(sessionUser)
  const library = appState?.library ?? emptyLibrary
  const visibleLibrary = library.filter((series) => isReaderCategory(series.category))
  const selectedSeriesSummary =
    library.find((series) => series.id === selectedSeriesId) ?? null
  const selectedSeriesDisplayTitle = selectedSeriesSummary
    ? getSeriesDisplayTitle(selectedSeriesSummary)
    : null
  const scanStatus = appState?.scanStatus ?? null
  const scanIsActive = Boolean(scanStatus?.active)
  const selectedSeries =
    (selectedSeriesId ? seriesCache[selectedSeriesId] : null) || null
  const currentEntry =
    selectedSeries?.entries.find((entry) => entry.id === selectedEntryId) ??
    selectedSeries?.entries[0] ??
    null
  const currentVariant =
    currentEntry?.variants.find((variant) => variant.id === selectedVariantId) ??
    currentEntry?.variants.find((variant) => variant.id === currentEntry.preferredVariantId) ??
    currentEntry?.variants[0] ??
    null
  const availableAnimeSeasons = getAvailableAnimeSeasons(selectedSeries)
  const visibleSeriesEntries =
    selectedSeries?.category === 'anime' && availableAnimeSeasons.length > 1 && selectedSeasonNumber != null
      ? selectedSeries.entries.filter((entry) => entry.seasonNumber === selectedSeasonNumber)
      : selectedSeries?.entries ?? []
  const selectedEntryIndex = currentEntry
    ? selectedSeries?.entries.findIndex((entry) => entry.id === currentEntry.id) ?? 0
    : 0
  const currentSavedPosition =
    currentVariant && appState?.readingPositions
      ? appState.readingPositions[currentVariant.id]
      : undefined
  const currentReaderStartPosition =
    currentVariant && readerResumeVariantId === currentVariant.id
      ? readerResumePosition
      : currentSavedPosition ?? null
  const metadataReviewItems = appState?.metadataQueue ?? emptyMetadataReviewItems
  const metadataSearchResults = metadataSearchQuery.trim()
    ? library
        .filter((series) =>
          getSeriesDisplayTitle(series).toLowerCase().includes(metadataSearchQuery.trim().toLowerCase())
        )
        .slice(0, 10)
    : []
  const selectedMetadataSeries =
    (selectedMetadataSeriesId
      ? library.find((series) => series.id === selectedMetadataSeriesId) ?? null
      : null) ||
    (metadataReviewItems[0]
      ? library.find((series) => series.id === metadataReviewItems[0].id) ?? null
      : null)
  const creatorProfiles = Object.values(
    visibleLibrary.reduce<Record<string, CreatorProfile>>((profiles, series) => {
      if (!series.sourceName) {
        return profiles
      }

      const key = normalizeBrowseToken(series.sourceName)
      if (!key) {
        return profiles
      }

      const existingProfile = profiles[key]
      if (existingProfile) {
        if (!existingProfile.categories.includes(series.category)) {
          existingProfile.categories.push(series.category)
          existingProfile.categories.sort(
            (left, right) => categoryOrder.indexOf(left) - categoryOrder.indexOf(right),
          )
        }

        existingProfile.series.push(series)
        if (!existingProfile.role && series.sourceRole) {
          existingProfile.role = series.sourceRole
        }
        return profiles
      }

      profiles[key] = {
        key,
        name: series.sourceName,
        role: series.sourceRole,
        categories: [series.category],
        series: [series],
      }
      return profiles
    }, {}),
  )
    .map((profile) => ({
      ...profile,
      series: [...profile.series].sort((left, right) => left.title.localeCompare(right.title)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const selectedCreatorProfile =
    (selectedCreatorKey
      ? creatorProfiles.find((profile) => profile.key === selectedCreatorKey) ?? null
      : null)
  const selectedSeriesCreatorProfile =
    selectedSeriesSummary?.sourceName
      ? creatorProfiles.find((profile) => profile.key === normalizeBrowseToken(selectedSeriesSummary.sourceName || '')) ?? null
      : null
  const relatedCreatorSeries = selectedSeriesSummary
    ? (selectedSeriesCreatorProfile?.series.filter((series) => series.id !== selectedSeriesSummary.id) ?? []).slice(0, 6)
    : []
  const bookTopicOptions = [...new Set(
    library
      .filter((series) => series.category === 'books')
      .flatMap((series) => getSeriesTopicTags(series)),
  )].sort((left, right) => left.localeCompare(right))

  const toBootstrapState = (nextState: AppState | BootstrapState): BootstrapState => ({
    appName: nextState.appName,
    bootstrapAdmin: nextState.bootstrapAdmin,
    openSignup: nextState.openSignup,
    user: nextState.user,
  })

  useEffect(() => {
    let active = true

    const loadBootstrap = async () => {
      try {
        setBootLoading(true)
        const nextState = await api.getBootstrap()

        if (!active) {
          return
        }

        setBootstrapState(nextState)
        setStateError(null)
      } catch (error) {
        if (!active) {
          return
        }

        setStateError(error instanceof Error ? error.message : text.authErrorFallback)
      } finally {
        if (active) {
          setBootLoading(false)
        }
      }
    }

    void loadBootstrap()

    return () => {
      active = false
    }
  }, [text.authErrorFallback])

  useEffect(() => {
    if (!bootstrapState?.user || appState) {
      if (!bootstrapState?.user) {
        setStateLoading(false)
      }
      return
    }

    let active = true

    const loadState = async () => {
      try {
        setStateLoading(true)
        const nextState = await api.getState()

        if (!active) {
          return
        }

        setBootstrapState(toBootstrapState(nextState))
        setAppState(nextState)
        setSelectedSeriesId((previousSeriesId) => previousSeriesId || firstSeriesId(nextState))
        setStateError(null)
      } catch (error) {
        if (!active) {
          return
        }

        setStateError(error instanceof Error ? error.message : text.authErrorFallback)
      } finally {
        if (active) {
          setStateLoading(false)
        }
      }
    }

    void loadState()

    return () => {
      active = false
    }
  }, [appState, bootstrapState, text.authErrorFallback])

  useEffect(() => {
    const shouldPollForTransportRecovery =
      scanPollUntil != null && Date.now() < scanPollUntil

    if (scanPollUntil != null && !scanIsActive && !shouldPollForTransportRecovery) {
      setScanPollUntil(null)
      return
    }

    if (
      !authenticated ||
      appState?.user?.role !== 'admin' ||
      (!scanIsActive && !shouldPollForTransportRecovery)
    ) {
      return
    }

    let active = true
    let timeout = 0

    const pollState = async () => {
      try {
        const nextState = await api.getState()

        if (!active) {
          return
        }

        setAppState(nextState)
        setSeriesCache((previousCache) => {
          const validSeriesIds = new Set(nextState.library.map((series) => series.id))

          return Object.fromEntries(
            Object.entries(previousCache).filter(([seriesId]) => validSeriesIds.has(seriesId)),
          )
        })
        setSelectedSeriesId((previousSeriesId) =>
          previousSeriesId && nextState.library.some((series) => series.id === previousSeriesId)
            ? previousSeriesId
            : firstSeriesId(nextState),
        )

        const shouldKeepPolling =
          nextState.scanStatus.active ||
          (scanPollUntil != null && Date.now() < scanPollUntil)

        if (shouldKeepPolling) {
          timeout = window.setTimeout(pollState, nextState.scanStatus.active ? 1250 : 2000)
        } else if (scanPollUntil != null) {
          setScanPollUntil(null)
        }
      } catch {
        if (active) {
          const shouldRetry =
            scanIsActive || (scanPollUntil != null && Date.now() < scanPollUntil)

          if (shouldRetry) {
            timeout = window.setTimeout(pollState, 2000)
          } else if (scanPollUntil != null) {
            setScanPollUntil(null)
          }
        }
      }
    }

    timeout = window.setTimeout(pollState, 1250)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [appState?.user?.role, authenticated, scanIsActive, scanPollUntil])

  useEffect(() => {
    if (!selectedSeries || selectedSeries.category !== 'anime') {
      setSelectedSeasonNumber(null)
      return
    }

    const seasons = getAvailableAnimeSeasons(selectedSeries)

    if (seasons.length <= 1) {
      setSelectedSeasonNumber(seasons[0] ?? null)
      return
    }

    setSelectedSeasonNumber((previousSeasonNumber) =>
      previousSeasonNumber != null && seasons.includes(previousSeasonNumber)
        ? previousSeasonNumber
        : seasons[0],
    )
  }, [selectedSeries])

  useEffect(() => {
    if (!authenticated || !deferredSearch) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }

    let active = true
    setSearchLoading(true)

    void api
      .search(deferredSearch, searchScope)
      .then((response) => {
        if (active) {
          setSearchResults(response.results)
        }
      })
      .catch(() => {
        if (active) {
          setSearchResults([])
        }
      })
      .finally(() => {
        if (active) {
          setSearchLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [authenticated, deferredSearch, searchScope])

  useEffect(() => {
    if (!isReaderCategory(currentCategory)) {
      setCurrentCategory(defaultReaderCategory)
    }
  }, [currentCategory])

  useEffect(() => {
    if (bookmarkFilter !== 'all' && !isReaderCategory(bookmarkFilter)) {
      setBookmarkFilter('all')
    }
  }, [bookmarkFilter])

  useEffect(() => {
    setOpenBookmarkMenuKey(null)
  }, [bookmarkFilter, currentView])

  useEffect(() => {
    if (searchScope !== 'all' && !isReaderCategory(searchScope)) {
      setSearchScope('all')
    }
  }, [searchScope])

  useEffect(() => {
    if (!isReaderCategory(browseCategory)) {
      setBrowseCategory(defaultReaderCategory)
    }
  }, [browseCategory])

  useEffect(() => {
    if (!authenticated || currentView === 'reader' || searchOpen || filterSheetOpen) {
      setTopbarHidden(false)
      return
    }

    const mobileQuery = window.matchMedia('(max-width: 900px)')

    const syncTopbar = () => {
      if (!mobileQuery.matches) {
        setTopbarHidden(false)
        return
      }

      const nextScrollY = window.scrollY
      const delta = nextScrollY - lastScrollYRef.current

      if (nextScrollY < 32 || delta < -8) {
        setTopbarHidden(false)
      } else if (nextScrollY > 120 && delta > 8) {
        setTopbarHidden(true)
      }

      lastScrollYRef.current = nextScrollY
    }

    lastScrollYRef.current = window.scrollY
    window.addEventListener('scroll', syncTopbar, { passive: true })
    mobileQuery.addEventListener('change', syncTopbar)
    syncTopbar()

    return () => {
      window.removeEventListener('scroll', syncTopbar)
      mobileQuery.removeEventListener('change', syncTopbar)
    }
  }, [authenticated, currentView, filterSheetOpen, searchOpen])

  useEffect(() => {
    if (!appState?.sourceRoots.length) {
      setSelectedRootId('')
      setBrowsePath('')
      setDirectoryListing({ currentPath: '', directories: [] })
      return
    }

    setSelectedRootId((previousRootId) => {
      const existingRoot = appState.sourceRoots.find((root) => root.id === previousRootId)
      const managedRoot = appState.sourceRoots.find((root) => root.managed)

      if (existingRoot?.managed) {
        return existingRoot.id
      }

      return (managedRoot || existingRoot || appState.sourceRoots[0]).id
    })
  }, [appState?.sourceRoots])

  useEffect(() => {
    if (
      currentView !== 'admin' ||
      !authenticated ||
      appState?.user?.role !== 'admin' ||
      !selectedRootId
    ) {
      return
    }

    let active = true

    void api
      .listDirectories(selectedRootId, browsePath)
      .then((listing) => {
        if (active) {
          setDirectoryListing(listing)
        }
      })
      .catch(() => {
        if (active) {
          setDirectoryListing({ currentPath: browsePath, directories: [] })
        }
      })

    return () => {
      active = false
    }
  }, [appState?.user?.role, authenticated, browsePath, currentView, selectedRootId])

  useEffect(() => {
    if (!selectedSeriesId || !authenticated || seriesCache[selectedSeriesId]) {
      return
    }

    let active = true
    setSeriesLoadingId(selectedSeriesId)
    setSeriesError(null)

    void api
      .getSeries(selectedSeriesId)
      .then((response) => {
        if (!active) {
          return
        }

        setSeriesCache((previousCache) => ({
          ...previousCache,
          [response.series.id]: response.series,
        }))
        setSelectedEntryId((previousEntryId) => previousEntryId || response.series.entries[0]?.id || null)
        setSelectedVariantId((previousVariantId) => {
          if (
            previousVariantId &&
            response.series.entries.some((entry) =>
              entry.variants.some((variant) => variant.id === previousVariantId),
            )
          ) {
            return previousVariantId
          }

          return response.series.entries[0]?.preferredVariantId || null
        })
      })
      .catch((error) => {
        if (active) {
          setSeriesError(error instanceof Error ? error.message : text.loadingSeries)
        }
      })
      .finally(() => {
        if (active) {
          setSeriesLoadingId(null)
        }
      })

    return () => {
      active = false
    }
  }, [authenticated, selectedSeriesId, seriesCache, text.loadingSeries])

  useEffect(() => {
    if (!selectedSeries || !selectedSeries.entries.length) {
      setSelectedEntryId(null)
      setSelectedVariantId(null)
      return
    }

    const resolvedSelection = findEntrySelection(selectedSeries, selectedEntryId)

    if (!resolvedSelection) {
      setSelectedEntryId(selectedSeries.entries[0].id)
      setSelectedVariantId(selectedSeries.entries[0].preferredVariantId)
      return
    }

    if (resolvedSelection.entry.id !== selectedEntryId) {
      setSelectedEntryId(resolvedSelection.entry.id)
    }

    setSelectedVariantId((previousVariantId) => {
      if (
        previousVariantId &&
        resolvedSelection.entry.variants.some((variant) => variant.id === previousVariantId)
      ) {
        return previousVariantId
      }

      return resolvedSelection.variant.id
    })
  }, [selectedEntryId, selectedSeries])

  useEffect(() => {
    if (!currentEntry) {
      setSelectedVariantId(null)
      return
    }

    if (!selectedVariantId || !currentEntry.variants.some((variant) => variant.id === selectedVariantId)) {
      setSelectedVariantId(currentEntry.preferredVariantId)
    }
  }, [currentEntry, selectedVariantId])

  useEffect(() => {
    if (!library.length) {
      return
    }

    const selectedSeriesStillExists = library.some((series) => series.id === selectedSeriesId)
    const firstVisibleSeries = library.find((series) => isReaderCategory(series.category))
    const selectedSeriesStillVisible =
      !firstVisibleSeries ||
      library.some((series) => series.id === selectedSeriesId && isReaderCategory(series.category))

    if (!selectedSeriesId || !selectedSeriesStillExists || !selectedSeriesStillVisible) {
      setSelectedSeriesId(firstVisibleSeries?.id || library[0].id)
    }
  }, [library, selectedSeriesId])

  useEffect(() => {
    if (!selectedCreatorKey) {
      return
    }

    if (!creatorProfiles.some((profile) => profile.key === selectedCreatorKey)) {
      setSelectedCreatorKey(null)
      if (currentView === 'creator') {
        setCurrentView('library')
      }
    }
  }, [creatorProfiles, currentView, selectedCreatorKey])

  useEffect(() => {
    if (selectedMetadataSeriesId && library.some((series) => series.id === selectedMetadataSeriesId)) {
      return
    }

    setSelectedMetadataSeriesId(metadataReviewItems[0]?.id || library[0]?.id || null)
  }, [library, metadataReviewItems, selectedMetadataSeriesId])

  useEffect(() => {
    if (!selectedMetadataSeries) {
      return
    }

    setMetadataTitleDraft(selectedMetadataSeries.title)
    setMetadataYearDraft(selectedMetadataSeries.year != null ? String(selectedMetadataSeries.year) : '')
    setMetadataDescriptionDraft(selectedMetadataSeries.description)
    setMetadataSourceNameDraft(selectedMetadataSeries.sourceName || '')
    setMetadataSourceRoleDraft(selectedMetadataSeries.sourceRole || '')
    setMetadataExternalUrlDraft(selectedMetadataSeries.externalUrl || '')
    setMetadataCoverUrlDraft('')
  }, [selectedMetadataSeries])

  useEffect(() => {
    if (currentView === 'reader') {
      return
    }

    setReaderProgress(savedPositionToReaderProgress(currentSavedPosition))
  }, [currentSavedPosition, currentView])

  const clearReaderChromeTimer = useCallback(() => {
    if (readerChromeTimerRef.current == null) {
      return
    }

    window.clearTimeout(readerChromeTimerRef.current)
    readerChromeTimerRef.current = null
  }, [])

  const revealReaderChrome = useCallback(() => {
    clearReaderChromeTimer()
    setReaderChromeVisible(true)
  }, [clearReaderChromeTimer])

  const toggleReaderChrome = useCallback(() => {
    clearReaderChromeTimer()
    setReaderChromeVisible((visible) => !visible)
  }, [clearReaderChromeTimer])

  useEffect(() => {
    if (currentView !== 'reader') {
      clearReaderChromeTimer()
      setReaderChromeVisible(true)
      return
    }

    revealReaderChrome()

    return clearReaderChromeTimer
  }, [
    clearReaderChromeTimer,
    currentEntry?.id,
    currentVariant?.id,
    currentView,
    revealReaderChrome,
  ])

  useEffect(() => {
    const currentVariantId = currentVariant?.id ?? null

    if (currentView !== 'reader' || !currentVariantId || readerResumeVariantId === currentVariantId) {
      return
    }

    const resumePosition = appState?.readingPositions?.[currentVariantId] ?? null

    setReaderResumeVariantId(currentVariantId)
    setReaderResumePosition(resumePosition)
    setReaderProgress(savedPositionToReaderProgress(resumePosition))
    setBookmarkJustSet(false)
    lastAutoSaveKeyRef.current = null
  }, [appState?.readingPositions, currentVariant?.id, currentView, readerResumeVariantId])

  useEffect(() => {
    setBookmarkJustSet(false)
  }, [selectedEntryId, selectedVariantId])

  useLayoutEffect(() => {
    if (!authenticated) {
      return
    }

    let frame = 0
    let correctionFrame = 0
    let timeout = 0

    const resetScroll = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    }

    resetScroll()
    frame = window.requestAnimationFrame(() => {
      resetScroll()
      correctionFrame = window.requestAnimationFrame(resetScroll)
      timeout = window.setTimeout(resetScroll, 120)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(correctionFrame)
      window.clearTimeout(timeout)
    }
  }, [authenticated, currentCategory, currentView, selectedSeriesId])

  const categoryLabel = (category: CategoryId) => text.scopes[category]

  const applyState = (nextState: AppState) => {
    setBootstrapState(toBootstrapState(nextState))
    setAppState(nextState)
    setSeriesCache((previousCache) => {
      const validSeriesIds = new Set(nextState.library.map((series) => series.id))

      return Object.fromEntries(
        Object.entries(previousCache).filter(([seriesId]) => validSeriesIds.has(seriesId)),
      )
    })
    if (
      !selectedSeriesId ||
      !nextState.library.some((series) => series.id === selectedSeriesId && isReaderCategory(series.category))
    ) {
      setSelectedSeriesId(firstSeriesId(nextState))
    }
  }

  const ensureSeriesLoaded = async (seriesId: string) => {
    if (seriesCache[seriesId]) {
      return seriesCache[seriesId]
    }

    const response = await api.getSeries(seriesId)
    setSeriesCache((previousCache) => ({
      ...previousCache,
      [response.series.id]: response.series,
    }))
    return response.series
  }

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const payload = {
      username: String(formData.get('username') || ''),
      password: String(formData.get('password') || ''),
    }

    try {
      setAuthBusy(true)
      setAuthError(null)
      const nextState =
        authMode === 'signup' ? await api.signup(payload) : await api.login(payload)

      setStateLoading(false)
      applyState(nextState)
      startTransition(() => {
        setCurrentView('bookmarks')
        setSelectedSeriesId(
          nextState.bookmarks.find((bookmark) => isReaderCategory(bookmark.category))?.seriesId ||
            firstSeriesId(nextState),
        )
      })
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = async () => {
    await api.logout()
    const nextBootstrap = await api.getBootstrap()
    setBootstrapState(nextBootstrap)
    setAppState(null)
    setSeriesCache({})
    setSearchQuery('')
    setSearchOpen(false)
    setFilterSheetOpen(false)
    setSelectedVariantId(null)
    setReaderResumeVariantId(null)
    setReaderResumePosition(null)
    setReaderProgress(null)
    setStateLoading(false)
    setCurrentView('bookmarks')
  }

  const goToLibrary = (category: CategoryId) => {
    const nextCategory = resolveReaderCategory(category)

    startTransition(() => {
      setCurrentCategory(nextCategory)
      setCurrentView('library')
      setFilterSheetOpen(false)
      setSearchOpen(false)
      setSearchQuery('')
    })
  }

  const openCreatorProfile = (sourceName: string | null) => {
    if (!sourceName) {
      return
    }

    const creatorKey = normalizeBrowseToken(sourceName)
    if (!creatorKey) {
      return
    }

    startTransition(() => {
      setSelectedCreatorKey(creatorKey)
      setCurrentView('creator')
    })
  }

  const openBooksTopic = (topic: string) => {
    startTransition(() => {
      setCurrentCategory('books')
      setBookTopicFilters([topic])
      setCurrentView('library')
      setFilterSheetOpen(false)
      setSearchOpen(false)
      setSearchQuery('')
    })
  }

  function primeReaderResume(variantId: string | null) {
    const resumePosition = variantId ? appState?.readingPositions?.[variantId] ?? null : null

    setReaderResumeVariantId(variantId)
    setReaderResumePosition(resumePosition)
    setReaderProgress(savedPositionToReaderProgress(resumePosition))
    setBookmarkJustSet(false)
    lastAutoSaveKeyRef.current = null
  }

  const openSeries = async (seriesId: string, tab: SeriesTabId = 'entries') => {
    const nextSummary = library.find((series) => series.id === seriesId)

    if (!nextSummary || !isReaderCategory(nextSummary.category)) {
      return
    }

    await ensureSeriesLoaded(seriesId)

    startTransition(() => {
      setSelectedSeriesId(seriesId)
      setCurrentCategory(nextSummary.category)
      setActiveTab(tab)
      setFilterSheetOpen(false)
      setSearchOpen(false)
      if (selectedSeriesId !== seriesId) {
        setSelectedEntryId(null)
        setSelectedVariantId(null)
      }
      setCurrentView('series')
    })
  }

  const openReader = async (seriesId: string, entryId?: string) => {
    const nextSummary = library.find((series) => series.id === seriesId)

    if (!nextSummary || !isReaderCategory(nextSummary.category)) {
      return
    }

    const detail = await ensureSeriesLoaded(seriesId)
    const resolvedSelection = findEntrySelection(detail, entryId)
    const nextEntry = resolvedSelection?.entry ?? detail.entries[0] ?? null
    const nextVariant =
      resolvedSelection?.variant ??
      nextEntry?.variants.find((variant) => variant.id === nextEntry.preferredVariantId) ??
      nextEntry?.variants[0] ??
      null

    startTransition(() => {
      setSelectedSeriesId(seriesId)
      setCurrentCategory(nextSummary.category)
      setFilterSheetOpen(false)
      setSearchOpen(false)
      setSelectedEntryId(nextEntry?.id ?? null)
      setSelectedVariantId(nextVariant?.id ?? null)
      primeReaderResume(nextVariant?.id ?? null)
      setCurrentView('reader')
    })
  }

  const moveEntry = (direction: -1 | 1) => {
    if (!selectedSeries || !currentEntry) {
      return
    }

    const currentIndex = selectedSeries.entries.findIndex((entry) => entry.id === currentEntry.id)
    const nextIndex = Math.min(
      Math.max(currentIndex + direction, 0),
      selectedSeries.entries.length - 1,
    )

    const nextEntry = selectedSeries.entries[nextIndex]
    const nextVariant =
      nextEntry?.variants.find((variant) => variant.id === nextEntry.preferredVariantId) ??
      nextEntry?.variants[0] ??
      null

    setSelectedEntryId(nextEntry?.id || null)
    setSelectedVariantId(nextVariant?.id ?? null)
    primeReaderResume(nextVariant?.id ?? null)
  }

  const handleReaderProgressChange = (progress: ReaderProgress) => {
    setReaderProgress((previousProgress) => {
      if (
        previousProgress?.page === progress.page &&
        previousProgress?.endPage === progress.endPage &&
        previousProgress?.totalPages === progress.totalPages &&
        previousProgress?.viewMode === progress.viewMode &&
        previousProgress?.locationType === progress.locationType &&
        previousProgress?.progressLabel === progress.progressLabel &&
        previousProgress?.cueLabel === progress.cueLabel
      ) {
        return previousProgress
      }

      return progress
    })
  }

  const persistCurrentReaderPosition = useCallback(async (manual = false) => {
    if (!selectedSeriesSummary || !currentEntry || !currentVariant || !appState?.user) {
      return
    }

    const currentProgress =
      readerProgress ||
      (currentReaderStartPosition
        ? {
            page: currentReaderStartPosition.page,
            totalPages: currentReaderStartPosition.totalPages ?? 1,
            viewMode: currentReaderStartPosition.viewMode,
            locationType: currentReaderStartPosition.locationType,
            progressLabel: currentReaderStartPosition.progressLabel,
            cueLabel: currentReaderStartPosition.cueLabel,
          }
        : {
            page: selectedSeriesSummary.category === 'novels' ? 0 : 1,
            totalPages: 1,
          })

    const bookmarkSummary = buildReaderLocation(
      selectedSeriesSummary.category,
      currentProgress,
      currentEntry.label,
    )

    const payload = {
      seriesId: selectedSeriesSummary.id,
      entryId: currentVariant.id,
      entryIndex: selectedEntryIndex,
      category: selectedSeriesSummary.category,
      progress: bookmarkSummary.progress,
      cue: bookmarkSummary.cue,
      position: {
        page: currentProgress.page,
        totalPages: currentProgress.totalPages,
        viewMode: currentProgress.viewMode,
        locationType: currentProgress.locationType,
        progressLabel: currentProgress.progressLabel,
        cueLabel: currentProgress.cueLabel,
      },
    }

    const saveKey = JSON.stringify(payload)

    if (!manual && lastAutoSaveKeyRef.current === saveKey) {
      return
    }

    lastAutoSaveKeyRef.current = saveKey

    const response = await api.setBookmark(payload)

    setAppState((previousState) =>
      previousState
        ? {
            ...previousState,
            bookmarks: response.bookmarks,
            readingPositions: response.readingPositions,
          }
        : previousState,
    )

    if (manual) {
      setBookmarkJustSet(true)
    }
  }, [
    appState?.user,
    currentEntry,
    currentReaderStartPosition,
    currentVariant,
    readerProgress,
    selectedEntryIndex,
    selectedSeriesSummary,
  ])

  const handleSetBookmark = async () => {
    await persistCurrentReaderPosition(true)
  }

  const handleRemoveBookmark = async (seriesId: string) => {
    try {
      setRemovingBookmarkSeriesId(seriesId)
      const response = await api.removeBookmark(seriesId)

      setAppState((previousState) =>
        previousState
          ? {
              ...previousState,
              bookmarks: response.bookmarks,
              readingPositions: response.readingPositions,
            }
          : previousState,
      )
      setOpenBookmarkMenuKey(null)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setRemovingBookmarkSeriesId(null)
    }
  }

  useEffect(() => {
    if (
      currentView !== 'reader' ||
      !readerProgress ||
      !selectedSeriesSummary ||
      !currentEntry ||
      !currentVariant ||
      !appState?.user
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      void persistCurrentReaderPosition(false)
    }, 1400)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [
    appState?.user,
    currentEntry,
    currentVariant,
    currentView,
    persistCurrentReaderPosition,
    readerProgress,
    selectedEntryIndex,
    selectedSeriesSummary,
  ])

  const handleReaderBackToList = async () => {
    await persistCurrentReaderPosition(false)

    if (selectedSeriesSummary) {
      await openSeries(selectedSeriesSummary.id, 'entries')
    }
  }

  const handleReaderTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]

    if (!touch) {
      return
    }

    const edge =
      touch.clientX <= 26 ? 'left' : touch.clientX >= window.innerWidth - 26 ? 'right' : null

    readerTouchStartRef.current = {
      edge,
      x: touch.clientX,
      y: touch.clientY,
    }
  }

  const handleReaderTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = readerTouchStartRef.current
    const touch = event.changedTouches[0]
    readerTouchStartRef.current = null

    if (!start || !touch) {
      return
    }

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    const moved = Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12
    const isEdgeSwipe = start.edge && Math.abs(deltaY) <= 72 && Math.abs(deltaX) >= 84

    if (isEdgeSwipe && start.edge === 'left' && deltaX > 0) {
      void handleReaderBackToList()
      return
    }

    if (isEdgeSwipe && start.edge === 'right' && deltaX < 0) {
      void persistCurrentReaderPosition(false)
      moveEntry(1)
      return
    }

    if (!moved && !isReaderChromeInteractionTarget(event.target)) {
      lastReaderTouchToggleRef.current = Date.now()
      toggleReaderChrome()
    }
  }

  const handleReaderClick = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastReaderTouchToggleRef.current < 450) {
      return
    }

    if (isReaderChromeInteractionTarget(event.target)) {
      return
    }

    toggleReaderChrome()
  }

  const handlePostComment = async () => {
    if (!selectedSeries || !commentDraft.trim()) {
      return
    }

    try {
      setCommentBusy(true)
      const response = await api.addComment({
        seriesId: selectedSeries.id,
        text: commentDraft,
      })
      setSeriesCache((previousCache) => ({
        ...previousCache,
        [response.series.id]: response.series,
      }))
      setCommentDraft('')
    } finally {
      setCommentBusy(false)
    }
  }

  const handleAddMountedRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    try {
      setAdminBusy(true)
      const nextState = await api.createRoot({
        label: rootLabel,
        path: rootPath,
      })
      applyState(nextState)
      setRootPath('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleLinkCurrentFolder = async () => {
    if (!selectedRootId) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.createSource({
        rootId: selectedRootId,
        relativePath: directoryListing.currentPath,
        category: browseCategory,
      })
      applyState(nextState)
      setImportStep('type')
      setBrowsePath('')
      setManualFolderPath('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleUseManualFolderPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const selectedRoot = appState?.sourceRoots.find((root) => root.id === selectedRootId)
    if (!selectedRoot) {
      return
    }

    const nextPath = resolveRelativeFolderInput(manualFolderPath, selectedRoot)
    if (nextPath == null) {
      setStateError(text.folderPathOutsideRoot)
      return
    }

    setStateError(null)
    setBrowsePath(nextPath)
    setImportStep('folder')
  }

  const handleUpdateSourceCategory = async (sourceId: string, category: CategoryId) => {
    try {
      setAdminBusy(true)
      const nextState = await api.updateSource(sourceId, { category })
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleUnlinkRoot = async (rootId: string) => {
    try {
      setAdminBusy(true)
      const nextState = await api.deleteRoot(rootId)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleRunScan = async (sourceId?: string) => {
    setScanClientNotice({
      id: `client-scan-start-${Date.now()}`,
      level: 'info',
      message: text.scanStartQueued,
      createdAt: new Date().toISOString(),
    })
    setScanPollUntil(Date.now() + 60000)

    try {
      setAdminBusy(true)
      const nextState = await api.runScan(sourceId)
      applyState(nextState)
      setStateError(null)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : text.authErrorFallback

      setScanClientNotice({
        id: `client-scan-error-${Date.now()}`,
        level: 'error',
        message: `${text.scanRequestLost}: ${errorMessage}`,
        createdAt: new Date().toISOString(),
      })
      setScanPollUntil(Date.now() + 60000)

      try {
        const nextState = await api.getState()
        applyState(nextState)
      } catch {
        // Keep the raw scan log notice visible while the recovery poll retries.
      }
    } finally {
      setAdminBusy(false)
    }
  }

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const currentPassword = String(formData.get('currentPassword') || '')
    const newPassword = String(formData.get('newPassword') || '')
    const confirmPassword = String(formData.get('confirmPassword') || '')

    setPasswordChangeError(null)
    setPasswordChangeSuccess(null)

    if (newPassword !== confirmPassword) {
      setPasswordChangeError(text.passwordMismatch)
      return
    }

    try {
      setPasswordChangeBusy(true)
      const nextState = await api.changePassword({
        currentPassword,
        newPassword,
      })
      applyState(nextState)
      event.currentTarget.reset()
      setPasswordChangeSuccess(text.passwordChangeSuccess)
    } catch (error) {
      setPasswordChangeError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setPasswordChangeBusy(false)
    }
  }

  const handleUnlinkSourceFolder = async (sourceId: string) => {
    try {
      setAdminBusy(true)
      const nextState = await api.deleteSource(sourceId)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleResetPassword = async (userId: string) => {
    const nextPassword = window.prompt(text.resetPasswordPrompt)

    if (!nextPassword) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.resetPassword(userId, { password: nextPassword })
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleSelectMetadataSeries = (seriesId: string) => {
    setSelectedMetadataSeriesId(seriesId)
  }

  const handleSaveMetadataOverride = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.saveMetadataOverride(selectedMetadataSeries.id, {
        title: metadataTitleDraft,
        year: metadataYearDraft.trim() ? Number(metadataYearDraft) : null,
        description: metadataDescriptionDraft,
        sourceName: metadataSourceNameDraft,
        sourceRole: metadataSourceRoleDraft,
        externalUrl: metadataExternalUrlDraft,
        coverImageUrl: metadataCoverUrlDraft,
      })
      applyState(nextState)
      setMetadataCoverUrlDraft('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleClearMetadataOverride = async () => {
    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.clearMetadataOverride(selectedMetadataSeries.id)
      applyState(nextState)
      setMetadataCoverUrlDraft('')
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleRefreshMetadataMatch = async () => {
    if (!selectedMetadataSeries) {
      return
    }

    try {
      setAdminBusy(true)
      const nextState = await api.refreshSeriesMetadata(selectedMetadataSeries.id)
      applyState(nextState)
    } catch (error) {
      setStateError(error instanceof Error ? error.message : text.authErrorFallback)
    } finally {
      setAdminBusy(false)
    }
  }

  const handleSearchBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setSearchOpen(false)
    }
  }

  const openSearch = () => {
    const mobileSearch = window.matchMedia('(max-width: 900px)').matches

    if (mobileSearch) {
      setCurrentView('search')
      setSearchOpen(false)
      return
    } else {
      setSearchOpen(true)
    }

    window.requestAnimationFrame(() => {
      if (mobileSearch) {
        mobileSearchInputRef.current?.focus()
      } else {
        searchInputRef.current?.focus()
      }
    })
  }

  const renderPoster = (series: SeriesSummary, compact = false, showCover = authenticated) => {
    const colors = posterColors[series.category]
    const hasCover = showCover && Boolean(series.coverUrl)
    const displayTitle = getSeriesDisplayTitle(series)
    const style = {
      '--poster-start': colors[0],
      '--poster-end': colors[1],
    } as CSSProperties

    return (
      <div
        className={`poster ${compact ? 'poster--compact' : ''} ${hasCover ? 'poster--covered' : ''}`}
        style={style}
      >
        {hasCover && (
          <img
            alt=""
            className="poster__image"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
            src={series.coverUrl || undefined}
          />
        )}
        <span className="poster__badge">{categoryLabel(series.category)}</span>
        <div className="poster__spark" />
        <div className="poster__copy">
          <span>{series.year || series.format}</span>
          <strong>{series.titleShort.trim() || displayTitle}</strong>
        </div>
      </div>
    )
  }

  const renderSeriesCard = (series: SeriesSummary) => {
    const displayTitle = getSeriesDisplayTitle(series)

    return (
      <button className="series-card" key={series.id} onClick={() => void openSeries(series.id)}>
        {renderPoster(series)}
        <div className="series-card__body">
          <div className="series-card__topline">
            <span className="section-kicker">{categoryLabel(series.category)}</span>
            <span className="series-card__progress">{series.progressLabel}</span>
          </div>
          <h3 className="series-card__title">{displayTitle}</h3>
          <p className="series-card__description">{series.description}</p>
          <div className="meta-row series-card__meta">
            <span>{series.year || series.format}</span>
            <span>{formatCountLabel(series.category, series.stats.fileCount, language)}</span>
            <span>{getSeriesSourceText(series)}</span>
          </div>
        </div>
      </button>
    )
  }

  const readerToolbarAccessory =
    currentEntry && currentEntry.variants.length > 1 && currentVariant ? (
      <ReaderVariantMenu
        onSelect={(variantId) => {
          setSelectedVariantId(variantId)
          primeReaderResume(variantId)
        }}
        selectedVariantId={currentVariant.id}
        variants={currentEntry.variants}
      />
    ) : null

  const filteredCategoryLibrary = visibleLibrary.filter((series) => {
    if (series.category !== currentCategory) {
      return false
    }

    if (currentCategory === 'books' && bookTopicFilters.length > 0) {
      const seriesTopics = getSeriesTopicTags(series)

      return bookTopicFilters.some((topic) => seriesTopics.includes(topic))
    }

    return true
  })
  const sortedCategoryLibrary = [...filteredCategoryLibrary].sort((left, right) => {
    if (discoverSort === 'year') {
      const leftYear = left.year ?? Number.MAX_SAFE_INTEGER
      const rightYear = right.year ?? Number.MAX_SAFE_INTEGER

      if (leftYear !== rightYear) {
        return leftYear - rightYear
      }
    }

    return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' })
  })
  const visibleSearchResults = searchResults.filter((series) => isReaderCategory(series.category))
  const libraryResults = deferredSearch !== '' ? visibleSearchResults : sortedCategoryLibrary
  const scopedSearchLibrary =
    searchScope === 'all'
      ? []
      : visibleLibrary
          .filter((series) => series.category === searchScope)
          .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }))

  const searchPreview = visibleSearchResults.slice(0, currentView === 'search' ? 50 : 10)
  const searchPageBrowseResults = deferredSearch === '' ? scopedSearchLibrary : []
  const bookmarks = appState?.bookmarks ?? []
  const readerBookmarks = bookmarks.filter((bookmark) => isReaderCategory(bookmark.category))
  const filteredBookmarks =
    bookmarkFilter === 'all'
      ? readerBookmarks
      : readerBookmarks.filter((bookmark) => bookmark.category === bookmarkFilter)
  const sortedBookmarks = [...filteredBookmarks].sort(
    (left, right) => new Date(right.lastSeen).getTime() - new Date(left.lastSeen).getTime(),
  )
  const getBookmarkStats = (bookmark: Bookmark, series: SeriesSummary) => {
    const entryTotal = Math.max(series.stats.fileCount, bookmark.entryIndex + 1, 1)
    const entryCurrent = Math.min(entryTotal, Math.max(bookmark.entryIndex + 1, 1))
    const entryRemaining = Math.max(entryTotal - entryCurrent, 0)
    const entryRatio = Math.max(0.02, Math.min(1, entryCurrent / entryTotal))

    if (shouldUseEntryBookmarkProgress(series.category)) {
      const entryLabel = getBookmarkEntryLabel(series.category, language)
      const remainingText = formatBookmarkRemaining(series.category, entryRemaining, language)

      return {
        current: entryCurrent,
        total: entryTotal,
        remaining: entryRemaining,
        ratio: entryRatio,
        mobileCurrent: String(entryCurrent),
        mobileSuffix: `/ ${entryTotal}`,
        cue:
          entryRemaining > 0
            ? `${entryLabel} ${entryCurrent} / ${entryTotal} - ${remainingText}`
            : `${entryLabel} ${entryCurrent} / ${entryTotal}`,
      }
    }

    const pageMatch = bookmark.progress.match(/pages?\s+(\d+)(?:-\d+)?\s+of\s+(\d+)/i)

    if (pageMatch) {
      const current = Number(pageMatch[1])
      const total = Math.max(Number(pageMatch[2]), current, 1)
      const remaining = Math.max(total - current, 0)

      return {
        current,
        total,
        remaining,
        ratio: Math.max(0.02, Math.min(1, current / total)),
        mobileCurrent: String(current),
        mobileSuffix: `/ ${total}`,
        cue:
          remaining > 0
            ? `Page ${current} / ${total} - ${remaining} ${remaining === 1 ? 'page' : 'pages'} left`
            : `Page ${current} / ${total}`,
      }
    }

    const percentMatch = bookmark.progress.match(/(\d+(?:\.\d+)?)%/)

    if (percentMatch) {
      const current = Math.round(Number(percentMatch[1]))
      const total = 100

      return {
        current,
        total,
        remaining: Math.max(total - current, 0),
        ratio: Math.max(0.02, Math.min(1, current / total)),
        mobileCurrent: `${current}%`,
        mobileSuffix: null,
        cue: bookmark.progress,
      }
    }

    return {
      current: entryCurrent,
      total: entryTotal,
      remaining: entryRemaining,
      ratio: entryRatio,
      mobileCurrent: String(entryCurrent),
      mobileSuffix: `/ ${entryTotal}`,
      cue: bookmark.progress,
    }
  }
  const pageTitle =
    currentView === 'bookmarks'
      ? text.nav.bookmarks
      : currentView === 'library'
        ? `${text.libraryTitle} / ${text.scopes[currentCategory]}${
            currentCategory === 'books' && bookTopicFilters.length > 0 ? ` / ${bookTopicFilters.join(', ')}` : ''
          }`
        : currentView === 'search'
          ? text.searchTitle
          : currentView === 'series'
            ? selectedSeriesDisplayTitle || text.loadingSeries
            : currentView === 'reader'
              ? `${selectedSeriesDisplayTitle || text.loadingSeries} / ${currentEntry?.label || ''}`
              : currentView === 'creator'
                ? selectedCreatorProfile?.name || text.creatorProfile
                : currentView === 'profile'
                  ? text.profile
                  : text.admin
  const pageBody =
    currentView === 'bookmarks'
      ? text.bookmarksBody
      : currentView === 'library'
        ? text.libraryBody
        : currentView === 'search'
          ? text.searchHint
          : currentView === 'series'
            ? selectedSeriesSummary?.description || text.loadingSeries
            : currentView === 'reader'
              ? (currentEntry ? formatDisplayEntryTitle(currentEntry.title) : text.loadingSeries)
              : currentView === 'creator'
                ? selectedCreatorProfile
                  ? `${selectedCreatorProfile.series.length} ${text.creatorWorks}`
                  : text.creatorProfile
                : currentView === 'profile'
                  ? text.passwordChangeHelp
                  : 'Mounted roots, linked folders, user resets, and metadata review stay in the admin area.'

  const renderBookmarks = () => (
    <div className="page page--bookmarks">
      <section className="toolbar-panel toolbar-panel--bookmarks">
        <div>
          <p className="section-kicker">{text.welcome}</p>
          <h2>
            <span className="desktop-only">{text.bookmarksHero}</span>
            <span className="mobile-only">{text.mobileNav.library}</span>
          </h2>
        </div>
        <button className="sort-pill" type="button">
          {text.librarySort}
        </button>
        <div className="bookmark-filter-bar" role="tablist" aria-label="Bookmark categories">
          {readerScopeOrder.map((scope) => (
            <button
              className={`tab-button ${bookmarkFilter === scope ? 'is-active' : ''}`}
              key={scope}
              onClick={() => setBookmarkFilter(scope)}
              type="button"
            >
              {text.scopes[scope]}
            </button>
          ))}
        </div>
      </section>

      {visibleLibrary.length === 0 ? (
        <article className="panel panel--padded">{text.noLibrary}</article>
      ) : (
        <section className="bookmark-list">
          {sortedBookmarks.length === 0 ? (
            <article className="panel panel--padded">No manual bookmark set yet.</article>
          ) : (
            sortedBookmarks.map((bookmark) => {
              const series = library.find((item) => item.id === bookmark.seriesId)

              if (!series) {
                return null
              }

              const displayTitle = getSeriesDisplayTitle(series)
              const progressHint = shouldUseEntryBookmarkProgress(series.category)
                ? null
                : getBookmarkProgressHint(bookmark)
              const bookmarkStats = getBookmarkStats(bookmark, series)
              const bookmarkMenuKey = `${bookmark.seriesId}-${bookmark.entryId}`
              const bookmarkMenuOpen = openBookmarkMenuKey === bookmarkMenuKey

              return (
                <article
                  className={`bookmark-card bookmark-card--list ${bookmarkMenuOpen ? 'is-menu-open' : ''}`}
                  key={`${bookmark.seriesId}-${bookmark.entryId}`}
                >
                  <button
                    aria-label={`${text.resume}: ${displayTitle}`}
                    className="bookmark-card__primary"
                    onClick={() => openReader(series.id, bookmark.entryId)}
                    type="button"
                  >
                    {renderPoster(series, true)}
                    <span className="bookmark-card__progress-track" aria-hidden="true">
                      <span style={{ width: `${bookmarkStats.ratio * 100}%` }} />
                    </span>
                    <span className="bookmark-card__mobile-meta">
                      <strong>{bookmarkStats.mobileCurrent}</strong>
                      {bookmarkStats.mobileSuffix && <span>{bookmarkStats.mobileSuffix}</span>}
                    </span>
                  </button>
                  <div className="bookmark-card__content">
                    <div className="bookmark-card__topline">
                      <span className="section-kicker">{categoryLabel(series.category)}</span>
                      {progressHint && <span className="chip">{progressHint}</span>}
                    </div>
                    <div className="bookmark-card__headline">
                      <div>
                        <h4>{displayTitle}</h4>
                        <p>{bookmark.entryLabel}</p>
                      </div>
                    </div>
                    <p className="bookmark-card__cue">{bookmarkStats.cue}</p>
                    <div className="bookmark-card__actions">
                      <button
                        className="primary-button"
                        onClick={() => openReader(series.id, bookmark.entryId)}
                      >
                        <AppIcon name="read" />
                        {text.resume}
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => openSeries(series.id, 'entries')}
                      >
                        <AppIcon name="chevronRight" />
                        {text.openSeries}
                      </button>
                    </div>
                  </div>
                  <button
                    aria-expanded={bookmarkMenuOpen}
                    aria-label={`${text.bookmarkActions}: ${displayTitle}`}
                    className="bookmark-card__menu"
                    onClick={() => setOpenBookmarkMenuKey((currentKey) => (
                      currentKey === bookmarkMenuKey ? null : bookmarkMenuKey
                    ))}
                    type="button"
                  >
                    <AppIcon name="more" />
                  </button>
                  {bookmarkMenuOpen && (
                    <div className="bookmark-card__menu-panel">
                      <button
                        onClick={() => {
                          setOpenBookmarkMenuKey(null)
                          void openSeries(series.id, 'entries')
                        }}
                        type="button"
                      >
                        <AppIcon name="chevronRight" />
                        {text.openSeries}
                      </button>
                      <button
                        disabled={removingBookmarkSeriesId === series.id}
                        onClick={() => void handleRemoveBookmark(series.id)}
                        type="button"
                      >
                        <AppIcon name="close" />
                        {text.removeBookmark}
                      </button>
                    </div>
                  )}
                </article>
              )
            })
          )}
        </section>
      )}
    </div>
  )

  const renderProfile = () => (
    <div className="page page--profile">
      <section className="profile-hero-panel">
        <span className="profile-avatar-large">
          {appState?.user?.username.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <p className="section-kicker">{text.profile}</p>
          <h2>{appState?.user?.username || text.profile}</h2>
          <p className="helper-text">{text.passwordChangeHelp}</p>
        </div>
      </section>

      <section className="settings-section">
        <h3>{text.accountActions}</h3>
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-row__icon">
              <AppIcon name="profile" />
            </span>
            <div>
              <strong>{text.accountSettings}</strong>
              <p>{appState?.user?.role || 'member'}</p>
            </div>
          </div>

          <div className="settings-row settings-row--split">
            <span className="settings-row__icon">
              <AppIcon name="language" />
            </span>
            <div>
              <strong>{text.language}</strong>
              <p>{language.toUpperCase()}</p>
            </div>
            <div className="language-toggle">
              <button
                className={language === 'en' ? 'is-active' : ''}
                onClick={() => setLanguage('en')}
                type="button"
              >
                EN
              </button>
              <button
                className={language === 'de' ? 'is-active' : ''}
                onClick={() => setLanguage('de')}
                type="button"
              >
                DE
              </button>
            </div>
          </div>

          {appState?.user?.role === 'admin' && (
            <button className="settings-row settings-row--button" onClick={() => setCurrentView('admin')} type="button">
              <span className="settings-row__icon">
                <AppIcon name="admin" />
              </span>
              <div>
                <strong>{text.adminTools}</strong>
                <p>{text.scanMode}</p>
              </div>
              <span className="settings-row__chevron">
                <AppIcon name="chevronRight" />
              </span>
            </button>
          )}

          <button className="settings-row settings-row--button" onClick={() => void handleLogout()} type="button">
            <span className="settings-row__icon">
              <AppIcon name="logout" />
            </span>
            <div>
              <strong>{text.logout}</strong>
              <p>{text.brandName}</p>
            </div>
            <span className="settings-row__chevron">
              <AppIcon name="chevronRight" />
            </span>
          </button>
        </div>
      </section>

      <section className="bookmark-settings-grid">
        <article className="panel panel--padded account-panel">
          <div className="panel__header">
            <div>
              <h3>{text.changePassword}</h3>
              <p className="helper-text">{text.passwordChangeHelp}</p>
            </div>
            <span className="settings-row__icon">
              <AppIcon name="key" />
            </span>
          </div>
          <form className="auth-form account-password-form" onSubmit={handleChangePassword}>
            <label>
              <span>{text.currentPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="current-password"
                autoCorrect="off"
                name="currentPassword"
                spellCheck={false}
                type="password"
              />
            </label>
            <label>
              <span>{text.newPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect="off"
                name="newPassword"
                spellCheck={false}
                type="password"
              />
            </label>
            <label>
              <span>{text.confirmPassword}</span>
              <input
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect="off"
                name="confirmPassword"
                spellCheck={false}
                type="password"
              />
            </label>

            {passwordChangeError && <p className="auth-error">{passwordChangeError}</p>}
            {passwordChangeSuccess && <p className="auth-success">{passwordChangeSuccess}</p>}

            <button className="primary-button" disabled={passwordChangeBusy} type="submit">
              {text.changePassword}
            </button>
          </form>
        </article>
      </section>
    </div>
  )

  const renderSearchPage = () => (
    <div className="page page--search">
      <section className="mobile-search-page">
        <div className="mobile-search-page__bar">
          <AppIcon name="search" />
          <input
            ref={mobileSearchInputRef}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={text.searchPlaceholder}
            value={searchQuery}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button className="ghost-button ghost-button--small" onClick={() => setSearchQuery('')} type="button">
              <AppIcon name="close" />
              {text.clearSearch}
            </button>
          )}
        </div>

        <div className="mobile-search-page__header">
          <h2>{text.searchTitle}</h2>
        </div>

        <div className="search-popover__scope">
          {readerScopeOrder.map((scope) => (
            <button
              className={`scope-button ${searchScope === scope ? 'is-active' : ''}`}
              key={scope}
              onClick={() => setSearchScope(scope)}
              type="button"
            >
              {text.scopes[scope]}
            </button>
          ))}
        </div>

        <div className="mobile-search-page__results">
          {deferredSearch === '' ? (
            searchPageBrowseResults.length > 0 ? (
              <section className="series-grid series-grid--shelf search-scope-grid">
                {searchPageBrowseResults.map((series) => renderSeriesCard(series))}
              </section>
            ) : (
              <article className="panel panel--padded search-state">{text.searchEmpty}</article>
            )
          ) : searchLoading ? (
            <article className="panel panel--padded search-state">{text.searching}</article>
          ) : searchPreview.length === 0 ? (
            <article className="panel panel--padded search-state">{text.searchNoMatches}</article>
          ) : (
            searchPreview.map((series) => (
              <button
                className="search-result"
                key={series.id}
                onClick={() => {
                  void openSeries(series.id)
                  setSearchOpen(false)
                }}
                type="button"
              >
                {renderPoster(series, true)}
                <div>
                  <strong>{getSeriesDisplayTitle(series)}</strong>
                  <p>{categoryLabel(series.category)} • {series.progressLabel}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )

  const renderLibrary = () => (
    <div className="page page--library">
      <section className="toolbar-panel">
        <div>
          <p className="section-kicker">{text.libraryTitle}</p>
          <h2>
            <span className="desktop-only">{pageTitle}</span>
            <span className="mobile-only">{text.mobileNav.discover}</span>
          </h2>
        </div>
        <div className="chip-row discover-meta-row">
          <span className="chip chip--accent">{text.scopes[currentCategory]}</span>
          <span className="chip">
            {libraryResults.length} {text.searchCount}
          </span>
          <span className="chip">
            {deferredSearch !== '' ? `Scope: ${text.scopes[searchScope]}` : text[discoverViewMode === 'grid' ? 'gridView' : 'listView']}
          </span>
        </div>
        <div className="discover-controls">
          <div className="segmented-control" aria-label={text.sortBy}>
            <button
              className={discoverSort === 'title' ? 'is-active' : ''}
              onClick={() => setDiscoverSort('title')}
              type="button"
            >
              {text.sortTitle}
            </button>
            <button
              className={discoverSort === 'year' ? 'is-active' : ''}
              onClick={() => setDiscoverSort('year')}
              type="button"
            >
              {text.sortYear}
            </button>
          </div>
          <div className="segmented-control" aria-label={text.viewMode}>
            <button
              className={discoverViewMode === 'grid' ? 'is-active' : ''}
              onClick={() => setDiscoverViewMode('grid')}
              type="button"
            >
              {text.gridView}
            </button>
            <button
              className={discoverViewMode === 'list' ? 'is-active' : ''}
              onClick={() => setDiscoverViewMode('list')}
              type="button"
            >
              {text.listView}
            </button>
          </div>
        </div>
        {currentCategory === 'books' && bookTopicOptions.length > 0 && deferredSearch === '' && (
          <div className="library-filter-summary">
            <button className="ghost-button" onClick={() => setFilterSheetOpen(true)} type="button">
              <AppIcon name="filter" />
              {text.filters}
            </button>
            <span className="chip">
              {bookTopicFilters.length === 0
                ? text.allTopics
                : `${text.activeFilter}: ${bookTopicFilters.length === 1 ? bookTopicFilters[0] : `${bookTopicFilters.length} selected`}`}
            </span>
          </div>
        )}
      </section>

      <section className="discover-tabs" role="tablist" aria-label={text.mobileNav.discover}>
        {readerCategoryOrder.map((category) => (
          <button
            className={`discover-tab ${currentCategory === category ? 'is-active' : ''}`}
            key={category}
            onClick={() => goToLibrary(category)}
            role="tab"
            type="button"
          >
            {text.nav[category]}
          </button>
        ))}
      </section>

      {currentCategory === 'books' && filterSheetOpen && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setFilterSheetOpen(false)}>
          <section
            aria-label={text.booksTopics}
            aria-modal="true"
            className="filter-sheet"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="filter-sheet__header">
              <div>
                <p className="section-kicker">{text.booksTopics}</p>
                <h3>{text.filters}</h3>
              </div>
              <button className="ghost-button ghost-button--small" onClick={() => setFilterSheetOpen(false)} type="button">
                <AppIcon name="close" />
                {text.closeFilters}
              </button>
            </div>
            <div className="filter-sheet__actions">
              <button
                className={`tab-button ${bookTopicFilters.length === 0 ? 'is-active' : ''}`}
                onClick={() => {
                  setBookTopicFilters([])
                }}
                type="button"
              >
                {bookTopicFilters.length === 0 && <AppIcon name="check" />}
                {text.allTopics}
              </button>
              {bookTopicFilters.length > 0 && (
                <button
                  className="ghost-button ghost-button--small"
                  onClick={() => setBookTopicFilters([])}
                  type="button"
                >
                  <AppIcon name="close" />
                  {text.clearFilter}
                </button>
              )}
            </div>
            <div className="filter-sheet__list" role="listbox" aria-multiselectable="true">
              {bookTopicOptions.map((topic) => (
                <button
                  aria-selected={bookTopicFilters.includes(topic)}
                  className={`filter-sheet__option ${bookTopicFilters.includes(topic) ? 'is-active' : ''}`}
                  key={topic}
                  onClick={() => {
                    setBookTopicFilters((previousFilters) =>
                      previousFilters.includes(topic)
                        ? previousFilters.filter((filter) => filter !== topic)
                        : [...previousFilters, topic],
                    )
                  }}
                  role="option"
                  type="button"
                >
                  <span>{topic}</span>
                  {bookTopicFilters.includes(topic) && (
                    <span>
                      <AppIcon name="check" />
                      Selected
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <section className={`series-grid ${discoverViewMode === 'grid' ? 'series-grid--shelf' : ''}`}>
        {libraryResults.map((series) => renderSeriesCard(series))}
      </section>
    </div>
  )

  const renderOverviewTab = () => {
    if (!selectedSeriesSummary) {
      return null
    }

    const visibleTags = getVisibleSeriesTags(selectedSeriesSummary)

    return (
      <div className="series-tab-grid">
        <article className="panel panel--padded series-overview-panel">
          <h3>{text.synopsis}</h3>
          <p className="series-overview-panel__description">{selectedSeriesSummary.description}</p>
          {selectedSeriesSummary.genres.length > 0 && (
            <div className="chip-row">
              {selectedSeriesSummary.genres.map((genre) => (
                <span className="chip chip--accent" key={genre}>
                  {genre}
                </span>
              ))}
            </div>
          )}
          {visibleTags.length > 0 && (
            <div className="chip-row">
              {visibleTags.map((tag) => (
                selectedSeriesSummary.category === 'books' ? (
                  <button
                    className="chip-button chip"
                    key={tag}
                    onClick={() => openBooksTopic(tag)}
                    type="button"
                  >
                    {tag}
                  </button>
                ) : (
                  <span className="chip" key={tag}>
                    {tag}
                  </span>
                )
              ))}
            </div>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.sourceDetails}</h3>
          <dl className="detail-list">
            {selectedSeriesSummary.sourceName && (
              <div>
                <dt>{text.sourceLabel}</dt>
                <dd>
                  <button
                    className="link-button"
                    onClick={() => openCreatorProfile(selectedSeriesSummary.sourceName)}
                    type="button"
                  >
                    {selectedSeriesSummary.sourceName}
                  </button>
                </dd>
              </div>
            )}
            {selectedSeriesSummary.sourceRole && (
              <div>
                <dt>{text.sourceRole}</dt>
                <dd>{selectedSeriesSummary.sourceRole}</dd>
              </div>
            )}
            <div>
              <dt>{text.onlineMatch}</dt>
              <dd>{selectedSeriesSummary.metadataSource}</dd>
            </div>
            {selectedSeriesSummary.year && (
              <div>
                <dt>Year</dt>
                <dd>{selectedSeriesSummary.year}</dd>
              </div>
            )}
          </dl>
          {selectedSeriesSummary.externalUrl && (
            <div className="series-overview-panel__actions">
              <a
                className="ghost-button"
                href={selectedSeriesSummary.externalUrl}
                rel="noreferrer"
                target="_blank"
              >
                {text.openSourcePage}
              </a>
            </div>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.moreFromCreator}</h3>
          {selectedSeriesCreatorProfile ? (
            <div className="action-stack">
              <button
                className="ghost-button"
                onClick={() => openCreatorProfile(selectedSeriesCreatorProfile.name)}
                type="button"
              >
                {text.openCreatorPage}
              </button>
              {relatedCreatorSeries.length > 0 ? (
                relatedCreatorSeries.map((series) => (
                  <button
                    className="list-link-button"
                    key={series.id}
                    onClick={() => void openSeries(series.id)}
                    type="button"
                  >
                    <span>{getSeriesDisplayTitle(series)}</span>
                    <span>{formatCountLabel(series.category, series.stats.fileCount, language)}</span>
                  </button>
                ))
              ) : (
                <p className="helper-text">{text.noRelatedCreatorTitles}</p>
              )}
            </div>
          ) : (
            <p className="helper-text">{text.noRelatedCreatorTitles}</p>
          )}
        </article>

        <article className="panel panel--padded">
          <h3>{text.seriesActions}</h3>
          <div className="action-stack">
            <button className="primary-button" onClick={() => void openReader(selectedSeriesSummary.id)}>
              {text.openReader}
            </button>
            <button className="ghost-button" onClick={() => setActiveTab('comments')}>
              {text.comments}
            </button>
            <button className="ghost-button" onClick={() => setCurrentView('bookmarks')}>
              {text.welcome}
            </button>
          </div>
        </article>

        <article className="panel panel--padded">
          <h3>{text.libraryDetails}</h3>
          <dl className="detail-list">
            <div>
              <dt>{text.localCover}</dt>
              <dd>{selectedSeriesSummary.coverSource}</dd>
            </div>
            <div>
              <dt>{text.entryDetails}</dt>
              <dd>{selectedSeriesSummary.format}</dd>
            </div>
            <div>
              <dt>{text.lastScan}</dt>
              <dd>{formatRelativeTime(selectedSeriesSummary.stats.lastScanAt, language)}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{selectedSeriesSummary.folder}</dd>
            </div>
          </dl>
        </article>
      </div>
    )
  }

  const renderEntriesTab = () => {
    if (seriesLoadingId === selectedSeriesId) {
      return <article className="panel panel--padded">{text.loadingSeries}</article>
    }

    if (!selectedSeries) {
      return <article className="panel panel--padded">{seriesError || text.loadingSeries}</article>
    }

    return (
      <div className="panel panel--padded">
        {selectedSeries.category === 'anime' && availableAnimeSeasons.length > 1 && (
          <div className="season-filter-bar" role="tablist" aria-label="Anime seasons">
            {availableAnimeSeasons.map((seasonNumber) => (
              <button
                className={`tab-button ${selectedSeasonNumber === seasonNumber ? 'is-active' : ''}`}
                key={seasonNumber}
                onClick={() => setSelectedSeasonNumber(seasonNumber)}
                type="button"
              >
                {formatSeasonLabel(seasonNumber, language)}
              </button>
            ))}
          </div>
        )}
        <table className="entry-table">
          <thead>
            <tr>
              <th>{text.entryLabel}</th>
              <th>{text.entryTitle}</th>
              <th>{text.entryDetails}</th>
              <th>{text.entryAction}</th>
            </tr>
          </thead>
          <tbody>
            {visibleSeriesEntries.map((entry) => (
              <tr key={entry.id}>
                <td data-label={text.entryLabel}>{entry.label}</td>
                <td data-label={text.entryTitle}>{formatDisplayEntryTitle(entry.title)}</td>
                <td data-label={text.entryDetails}>{entry.details}</td>
                <td data-label={text.entryAction}>
                  <button className="ghost-button" onClick={() => void openReader(selectedSeries.id, entry.id)}>
                    {text.openReader}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderCommentsTab = () => (
    <div className="comment-list">
      <article className="panel panel--padded comment-form">
        <h3>{text.addComment}</h3>
        <textarea
          className="comment-form__textarea"
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder={text.commentPlaceholder}
          value={commentDraft}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="comment-form__actions">
          <button
            className="primary-button"
            disabled={commentBusy || !commentDraft.trim()}
            onClick={() => void handlePostComment()}
            type="button"
          >
            {text.postComment}
          </button>
        </div>
      </article>

      {!selectedSeries || selectedSeries.comments.length === 0 ? (
        <article className="panel panel--padded">{text.commentsEmpty}</article>
      ) : (
        selectedSeries.comments.map((comment) => (
          <article className="comment-card" key={comment.id}>
            <div className="comment-card__header">
              <strong>{comment.user}</strong>
              <span>{formatDateTime(comment.when, language)}</span>
            </div>
            <p>{comment.text}</p>
          </article>
        ))
      )}
    </div>
  )

  const renderSeries = () => {
    if (!selectedSeriesSummary) {
      return <article className="panel panel--padded">{text.noLibrary}</article>
    }

    const seriesCountLabel = formatCountLabel(
      selectedSeriesSummary.category,
      selectedSeriesSummary.stats.fileCount,
      language,
    )

    return (
      <div className="page page--series">
        <section className={`series-hero ${selectedSeriesSummary.bannerUrl ? 'series-hero--banner' : ''}`}>
          {selectedSeriesSummary.bannerUrl && (
            <div
              aria-hidden="true"
              className="series-hero__banner"
              style={{ backgroundImage: `url(${selectedSeriesSummary.bannerUrl})` }}
            />
          )}
          <div className="series-hero__poster">{renderPoster(selectedSeriesSummary)}</div>
          <div className="series-hero__content">
            <div className="series-hero__header">
              <div>
                <p className="section-kicker">{categoryLabel(selectedSeriesSummary.category)}</p>
                <h2>{selectedSeriesDisplayTitle}</h2>
              </div>
              <div className="series-hero__header-actions">
                {selectedSeriesSummary.externalUrl && (
                  <a
                    className="ghost-button ghost-button--small"
                    href={selectedSeriesSummary.externalUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {text.openSourcePage}
                  </a>
                )}
                <span className="status-pill status-pill--ok">{selectedSeriesSummary.status}</span>
              </div>
            </div>

            <p>{selectedSeriesSummary.description}</p>

            <div className="chip-row">
              <span className="chip chip--accent">{selectedSeriesSummary.progressLabel}</span>
              {selectedSeriesSummary.sourceName && (
                <button
                  className="chip-button chip"
                  onClick={() => openCreatorProfile(selectedSeriesSummary.sourceName)}
                  type="button"
                >
                  {getSeriesSourceText(selectedSeriesSummary)}
                </button>
              )}
              {seriesCountLabel !== selectedSeriesSummary.progressLabel && (
                <span className="chip">{seriesCountLabel}</span>
              )}
              {selectedSeriesSummary.year && <span className="chip">{selectedSeriesSummary.year}</span>}
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(selectedSeriesSummary.stats.lastScanAt, language)}
              </span>
              {selectedSeriesSummary.genres.slice(0, 3).map((genre) => (
                <span className="chip" key={genre}>
                  {genre}
                </span>
              ))}
            </div>

            <div className="tab-row">
              <button
                className={`tab-button ${activeTab === 'overview' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('overview')}
              >
                {text.overview}
              </button>
              <button
                className={`tab-button ${activeTab === 'entries' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('entries')}
              >
                {text.entries}
              </button>
              <button
                className={`tab-button ${activeTab === 'comments' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('comments')}
              >
                {text.comments}
              </button>
            </div>
          </div>
        </section>

        {activeTab === 'overview' && renderOverviewTab()}
        {activeTab === 'entries' && renderEntriesTab()}
        {activeTab === 'comments' && renderCommentsTab()}
      </div>
    )
  }

  const renderCreator = () => {
    if (!selectedCreatorProfile) {
      return <article className="panel panel--padded">{text.creatorProfile}</article>
    }

    return (
      <div className="page page--creator">
        <section className="toolbar-panel creator-hero">
          <div>
            <p className="section-kicker">{text.creatorProfile}</p>
            <h2>{selectedCreatorProfile.name}</h2>
            <p className="creator-hero__body">
              {selectedCreatorProfile.role
                ? `${selectedCreatorProfile.role} • ${selectedCreatorProfile.series.length} ${text.creatorWorks}`
                : `${selectedCreatorProfile.series.length} ${text.creatorWorks}`}
            </p>
          </div>
          <div className="chip-row">
            {selectedCreatorProfile.role && <span className="chip chip--accent">{selectedCreatorProfile.role}</span>}
            {selectedCreatorProfile.categories.map((category) => (
              <button
                className="chip-button chip"
                key={category}
                onClick={() => goToLibrary(category)}
                type="button"
              >
                {text.scopes[category]}
              </button>
            ))}
            <span className="chip">
              {selectedCreatorProfile.series.length} {text.creatorWorks}
            </span>
          </div>
        </section>

        <section className="series-grid">{selectedCreatorProfile.series.map((series) => renderSeriesCard(series))}</section>
      </div>
    )
  }

  const renderReaderPreview = () => {
    if (!selectedSeriesSummary || !currentEntry || !currentVariant) {
      return <article className="panel panel--padded">{text.loadingSeries}</article>
    }

    if (selectedSeriesSummary.category === 'anime') {
      return (
        <div className="reader-layout">
          <VideoPlayer variant={currentVariant} />
        </div>
      )
    }

    if (currentVariant.format === 'cbz') {
      const useMangaPaging = selectedSeriesSummary.category === 'manga'

      return (
        <div className="reader-layout">
          <CbzReader
            fileUrl={currentVariant.fileUrl}
            initialPage={currentReaderStartPosition?.page ?? 1}
            initialPageOrderMode={useMangaPaging ? 'archive' : 'filename'}
            initialReadingDirection={useMangaPaging ? 'rtl' : 'ltr'}
            initialSpreadAlignment="cover-first"
            initialViewMode={currentReaderStartPosition?.viewMode ?? 'single'}
            onProgressChange={handleReaderProgressChange}
            preferenceKey={selectedSeriesSummary.id}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'md' || currentVariant.format === 'txt') {
      return (
        <div className="reader-layout">
          <TextFileReader
            fileUrl={currentVariant.fileUrl}
            format={currentVariant.format}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onProgressChange={handleReaderProgressChange}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'pdf') {
      return (
        <div className="reader-layout">
          <PdfEmbed
            fileUrl={currentVariant.fileUrl}
            initialPage={currentReaderStartPosition?.page ?? 1}
            onProgressChange={handleReaderProgressChange}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'html') {
      return (
        <div className="reader-layout">
          <HtmlChapterReader
            fileUrl={currentVariant.fileUrl}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onProgressChange={handleReaderProgressChange}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    if (currentVariant.format === 'epub') {
      return (
        <div className="reader-layout">
          <EpubReader
            fileUrl={currentVariant.fileUrl}
            initialProgress={currentReaderStartPosition?.page ?? 0}
            onProgressChange={handleReaderProgressChange}
            toolbarAccessory={readerToolbarAccessory}
            title={formatDisplayEntryTitle(currentEntry.title)}
          />
        </div>
      )
    }

    return (
      <div className="reader-layout">
        <article className="novel-card">
          <span className="section-kicker">{currentVariant.format.toUpperCase()}</span>
          <h3>{formatDisplayEntryTitle(currentEntry.title)}</h3>
          <p>
            This entry format is stored and indexed correctly, but it does not have a dedicated in-app renderer yet.
          </p>
          <div className="bookmark-card__actions">
            {readerToolbarAccessory}
            <button
              className="ghost-button"
              onClick={() => window.open(currentVariant.downloadUrl, '_blank', 'noopener,noreferrer')}
              type="button"
            >
              {text.openOriginal}
            </button>
          </div>
        </article>
      </div>
    )
  }

  const renderReader = () => {
    const readerTitle = currentEntry
      ? `${currentEntry.label}: ${formatDisplayEntryTitle(currentEntry.title)}`
      : text.loadingSeries
    const progressLabel =
      readerProgress?.progressLabel ||
      currentReaderStartPosition?.progressLabel ||
      (readerProgress ? buildReaderLocation(currentCategory, readerProgress, currentEntry?.label || '').progress : null) ||
      currentReaderStartPosition?.cueLabel ||
      currentEntry?.label ||
      ''
    const readerResetKey = `${currentVariant?.id ?? 'no-variant'}-${currentEntry?.id ?? 'no-entry'}`
    const renderReaderCrashFallback = (message: string | null) => (
      <div className="reader-layout">
        <article className="novel-card">
          <span className="section-kicker">{currentVariant?.format.toUpperCase() || 'Reader'}</span>
          <h3>{currentEntry ? formatDisplayEntryTitle(currentEntry.title) : text.loadingSeries}</h3>
          <p>
            This reader hit a browser rendering issue. The original file can still be opened directly.
          </p>
          {message && <p className="helper-text">{message}</p>}
          <div className="bookmark-card__actions">
            {currentVariant && (
              <button
                className="ghost-button"
                onClick={() => window.open(currentVariant.downloadUrl, '_blank', 'noopener,noreferrer')}
                type="button"
              >
                {text.openOriginal}
              </button>
            )}
          </div>
        </article>
      </div>
    )

    return (
      <div
        className={`page page--reader ${readerChromeVisible ? 'reader-chrome-visible' : 'reader-chrome-hidden'}`}
        onClick={handleReaderClick}
        onTouchEnd={handleReaderTouchEnd}
        onTouchStart={handleReaderTouchStart}
      >
        <section className="reader-overlay reader-overlay--top">
          <button
            className="reader-overlay__button"
            onClick={() => void handleReaderBackToList()}
            type="button"
          >
            <AppIcon name="back" />
            {text.backToList}
          </button>
          <div className="reader-overlay__title">
            <span>{selectedSeriesDisplayTitle || text.loadingSeries}</span>
            <strong>{readerTitle}</strong>
          </div>
        </section>

        <div className="reader-stage">
          <ReaderErrorBoundary fallback={renderReaderCrashFallback} resetKey={readerResetKey}>
            <Suspense fallback={<article className="panel panel--padded">{text.loadingSeries}</article>}>
              {renderReaderPreview()}
            </Suspense>
          </ReaderErrorBoundary>
        </div>

        <section className="reader-overlay reader-overlay--bottom">
          <button
            className="ghost-button"
            disabled={!selectedSeries || selectedEntryIndex === 0}
            onClick={() => moveEntry(-1)}
            type="button"
          >
            <AppIcon name="back" />
            <span className="reader-overlay__button-label" data-short-label={text.previousEntryShort}>
              {text.previousEntry}
            </span>
          </button>
          <div className="reader-overlay__progress">
            {progressLabel && <span>{progressLabel}</span>}
            <button className="primary-button" onClick={() => void handleSetBookmark()} type="button">
              <AppIcon name="check" />
              <span
                className="reader-overlay__button-label"
                data-short-label={bookmarkJustSet ? text.bookmarkedShort : text.setBookmarkShort}
              >
                {bookmarkJustSet ? text.bookmarked : text.setBookmark}
              </span>
            </button>
          </div>
          <button
            className="ghost-button"
            disabled={!selectedSeries || selectedEntryIndex === (selectedSeries.entries.length || 1) - 1}
            onClick={() => moveEntry(1)}
            type="button"
          >
            <span className="reader-overlay__button-label" data-short-label={text.nextEntryShort}>
              {text.nextEntry}
            </span>
            <AppIcon name="chevronRight" />
          </button>
        </section>
      </div>
    )
  }

  const renderScanLog = () => {
    const sourceProgressRatio =
      scanStatus?.currentSourceSeriesTotal && scanStatus.currentSourceSeriesTotal > 0
        ? Math.min(
            1,
            (scanStatus.currentSourceSeriesCompleted || 0) / scanStatus.currentSourceSeriesTotal,
          )
        : 0
    const rawScanEvents = [
      ...(scanStatus?.events || []),
      ...(scanClientNotice ? [scanClientNotice] : []),
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    const rawScanLines = [
      scanStatus?.runId
        ? `[${formatDateTime(scanStatus.startedAt, language)}] RUN ${scanStatus.runId} ${
            scanStatus.active ? 'running' : 'finished'
          }${scanStatus.summary ? ` - ${scanStatus.summary}` : ''}`
        : null,
      ...rawScanEvents.map(
        (event) =>
          `[${formatDateTime(event.createdAt, language)}] ${event.level.toUpperCase()} ${event.message}`,
      ),
    ].filter((line): line is string => Boolean(line))

    return (
      <article className="panel panel--padded admin-scan-log">
        <div className="panel__header">
          <h3>{text.scanActivity}</h3>
          <span>{scanIsActive ? text.scanInProgress : text.scanIdle}</span>
        </div>

        <div className="admin-scan-log__summary">
          <div className="chip-row">
            <span className={`chip ${scanIsActive ? 'chip--accent' : ''}`}>
              {scanIsActive
                ? `${scanStatus?.completedSources || 0} / ${scanStatus?.totalSources || 0}`
                : text.scanReady}
            </span>
            {scanStatus?.summary && <span className="chip">{scanStatus.summary}</span>}
            {scanStatus?.finishedAt && !scanIsActive && (
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(scanStatus.finishedAt, language)}
              </span>
            )}
          </div>

          <div className="admin-scan-log__live">
            <div className="admin-scan-log__progress-bar" aria-hidden="true">
              <span style={{ width: `${sourceProgressRatio * 100}%` } satisfies CSSProperties} />
            </div>

            <dl className="detail-list detail-list--inline admin-scan-log__metrics">
              <div>
                <dt>{text.linkedFolderProgress}</dt>
                <dd>
                  {scanStatus?.completedSources || 0} / {scanStatus?.totalSources || 0}
                </dd>
              </div>
              <div>
                <dt>{text.filesDiscovered}</dt>
                <dd>{scanStatus?.currentSourceFilesDiscovered?.toLocaleString() ?? '—'}</dd>
              </div>
              <div>
                <dt>{text.detectedSeries}</dt>
                <dd>{scanStatus?.currentSourceSeriesTotal?.toLocaleString() ?? '—'}</dd>
              </div>
              <div>
                <dt>{text.indexedSeries}</dt>
                <dd>
                  {scanStatus?.currentSourceSeriesTotal
                    ? `${scanStatus.currentSourceSeriesCompleted} / ${scanStatus.currentSourceSeriesTotal}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>{text.currentSource}</dt>
                <dd>{scanStatus?.currentSource || '—'}</dd>
              </div>
              <div>
                <dt>{text.currentSeries}</dt>
                <dd>{scanStatus?.currentSeries || '—'}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="admin-scan-log__events">
          {scanStatus?.events.length ? (
            scanStatus.events
              .slice()
              .reverse()
              .map((event) => (
                <div className="admin-scan-log__event" key={event.id}>
                  <span className={`status-pill admin-scan-log__level admin-scan-log__level--${event.level}`}>
                    {event.level}
                  </span>
                  <div className="admin-scan-log__event-body">
                    <strong>{event.message}</strong>
                    <span>{formatDateTime(event.createdAt, language)}</span>
                  </div>
                </div>
              ))
          ) : (
            <div className="admin-scan-log__empty">{text.scanLogEmpty}</div>
          )}
        </div>

        <div className="admin-scan-log__raw">
          <div className="admin-scan-log__raw-header">
            <strong>{text.scanRawLog}</strong>
            <span>{text.scanRawLogHelp}</span>
          </div>
          {rawScanLines.length ? (
            <pre>{rawScanLines.join('\n')}</pre>
          ) : (
            <div className="admin-scan-log__empty">{text.scanRawLogEmpty}</div>
          )}
        </div>
      </article>
    )
  }

  const renderMetadataReview = () => (
    <article className="panel panel--padded metadata-review">
      <div className="panel__header">
        <h3>{text.metadataReview}</h3>
        <span>{metadataReviewItems.length} items</span>
      </div>
      <div className="admin-list metadata-review__list">
        {metadataReviewItems.length ? (
          metadataReviewItems.map((item) => (
            <button
              className={`admin-row admin-row--button metadata-review__item ${
                selectedMetadataSeries?.id === item.id ? 'metadata-review__item--active' : ''
              }`}
              key={item.id}
              onClick={() => handleSelectMetadataSeries(item.id)}
              type="button"
            >
              {item.coverUrl ? (
                <img alt="" className="metadata-review__cover" src={item.coverUrl} />
              ) : (
                <div className="metadata-review__cover metadata-review__cover--empty" />
              )}
              <div className="metadata-review__body">
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                <div className="chip-row">
                  <span className="chip">{categoryLabel(item.category)}</span>
                  <span className={`status-pill ${item.status === 'Review' ? 'admin-scan-log__level--info' : 'status-pill--ok'}`}>
                    {item.status}
                  </span>
                </div>
              </div>
              <span className="metadata-review__reason">{item.reason}</span>
            </button>
          ))
        ) : (
          <div className="admin-scan-log__empty">{text.metadataNoItems}</div>
        )}
      </div>
    </article>
  )

  const renderMetadataEditor = () => (
    <article className="panel panel--padded metadata-editor">
      <div className="panel__header">
        <h3>{text.metadataEditor}</h3>
        <span>{selectedMetadataSeries ? categoryLabel(selectedMetadataSeries.category) : '—'}</span>
      </div>

      <label className="metadata-editor__search">
        <span>{text.quickResults}</span>
        <input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => setMetadataSearchQuery(event.target.value)}
          placeholder={text.metadataSearchPlaceholder}
          type="search"
          value={metadataSearchQuery}
        />
      </label>

      {metadataSearchResults.length > 0 && (
        <div className="metadata-editor__results">
          {metadataSearchResults.map((series) => (
            <button
              className="ghost-button ghost-button--small"
              key={series.id}
              onClick={() => {
                handleSelectMetadataSeries(series.id)
                setMetadataSearchQuery('')
              }}
              type="button"
            >
              {getSeriesDisplayTitle(series)}
            </button>
          ))}
        </div>
      )}

      {selectedMetadataSeries ? (
        <>
          <div className="metadata-editor__summary">
            {selectedMetadataSeries.coverUrl ? (
              <img alt="" className="metadata-editor__cover" src={selectedMetadataSeries.coverUrl} />
            ) : (
              <div className="metadata-editor__cover metadata-editor__cover--empty" />
            )}
            <div className="metadata-editor__summary-body">
              <strong>{selectedMetadataSeries.title}</strong>
              <p>{selectedMetadataSeries.description}</p>
              <dl className="detail-list">
                <div>
                  <dt>{text.metadataCurrentState}</dt>
                  <dd>{selectedMetadataSeries.coverSource} • {selectedMetadataSeries.metadataSource}</dd>
                </div>
                <div>
                  <dt>{text.metadataReason}</dt>
                  <dd>
                    {metadataReviewItems.find((item) => item.id === selectedMetadataSeries.id)?.reason || 'Metadata cached'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <form className="admin-form metadata-editor__form" onSubmit={handleSaveMetadataOverride}>
            <label>
              <span>{text.metadataOverrideTitle}</span>
              <input onChange={(event) => setMetadataTitleDraft(event.target.value)} type="text" value={metadataTitleDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideYear}</span>
              <input onChange={(event) => setMetadataYearDraft(event.target.value)} type="number" value={metadataYearDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideSourceName}</span>
              <input onChange={(event) => setMetadataSourceNameDraft(event.target.value)} type="text" value={metadataSourceNameDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideSourceRole}</span>
              <input onChange={(event) => setMetadataSourceRoleDraft(event.target.value)} type="text" value={metadataSourceRoleDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideExternalUrl}</span>
              <input onChange={(event) => setMetadataExternalUrlDraft(event.target.value)} type="url" value={metadataExternalUrlDraft} />
            </label>
            <label>
              <span>{text.metadataOverrideCoverUrl}</span>
              <input onChange={(event) => setMetadataCoverUrlDraft(event.target.value)} type="url" value={metadataCoverUrlDraft} />
            </label>
            <label className="metadata-editor__textarea">
              <span>{text.metadataOverrideDescription}</span>
              <textarea
                onChange={(event) => setMetadataDescriptionDraft(event.target.value)}
                rows={8}
                value={metadataDescriptionDraft}
              />
            </label>

            <div className="action-stack metadata-editor__actions">
              <button className="primary-button" disabled={adminBusy || scanIsActive} type="submit">
                {text.metadataSave}
              </button>
              <button
                className="ghost-button"
                disabled={adminBusy || scanIsActive}
                onClick={() => void handleRefreshMetadataMatch()}
                type="button"
              >
                {text.metadataRefresh}
              </button>
              <button
                className="ghost-button"
                disabled={adminBusy || scanIsActive}
                onClick={() => void handleClearMetadataOverride()}
                type="button"
              >
                {text.metadataClear}
              </button>
              <button
                className="ghost-button"
                onClick={() => void openSeries(selectedMetadataSeries.id, 'overview')}
                type="button"
              >
                {text.metadataOpenSeries}
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="admin-scan-log__empty">{text.metadataNoSelection}</div>
      )}
    </article>
  )

  const renderAdmin = () => {
    const sourceRoots = appState?.sourceRoots || []
    const linkedSourceFolders = appState?.sourceFolders || []
    const hasManagedRoot = sourceRoots.some((root) => root.managed)
    const rootOptions = [...sourceRoots].sort((left, right) => Number(right.managed) - Number(left.managed))
    const selectedRoot = sourceRoots.find((root) => root.id === selectedRootId) || rootOptions[0] || null
    const currentFolderLabel = directoryListing.currentPath || '/'
    const selectedFolderDisplayPath = selectedRoot
      ? joinMountedDisplayPath(selectedRoot.path, directoryListing.currentPath)
      : ''
    const selectedFolderAlreadyLinked =
      selectedFolderDisplayPath !== '' &&
      linkedSourceFolders.some(
        (folder) =>
          normalizeFolderInput(folder.path).toLowerCase() ===
          normalizeFolderInput(selectedFolderDisplayPath).toLowerCase(),
      )
    const canReviewFolder = Boolean(selectedRootId && directoryListing.currentPath)
    const importSteps: Array<{ id: ImportStepId; label: string }> = [
      { id: 'type', label: text.importStepType },
      { id: 'folder', label: text.importStepFolder },
      { id: 'review', label: text.importStepReview },
    ]
    const rootTitle = (root: MountedRootSummary) => (root.managed ? text.importMainArchive : root.label)
    const rootSubtitle = (root: MountedRootSummary) => (root.managed ? text.importDockerRoot : root.note)

    return (
      <div className="page page--admin">
        <section className="admin-grid">
          <article className="panel panel--padded media-import-panel">
            <div className="panel__header media-import-panel__header">
              <div>
                <h3>{text.addMediaFolder}</h3>
                <p>{text.addMediaFolderBody}</p>
              </div>
            </div>

            <div className="import-stepper" role="tablist" aria-label={text.addMediaFolder}>
              {importSteps.map((step, index) => (
                <button
                  aria-selected={importStep === step.id}
                  className={`import-stepper__item${importStep === step.id ? ' import-stepper__item--active' : ''}`}
                  key={step.id}
                  onClick={() => setImportStep(step.id)}
                  role="tab"
                  type="button"
                >
                  <span>{index + 1}</span>
                  {step.label}
                </button>
              ))}
            </div>

            <div className="media-import-layout">
              <div className="import-flow-card">
                {importStep === 'type' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepType}</span>
                      <h4>{text.importTypeTitle}</h4>
                      <p>{text.importTypeBody}</p>
                    </div>
                    <div className="source-category-picker" aria-label={text.folderCategory} role="radiogroup">
                      {readerCategoryOrder.map((category) => (
                        <button
                          aria-checked={browseCategory === category}
                          className={`source-category-picker__option${browseCategory === category ? ' source-category-picker__option--active' : ''}`}
                          key={category}
                          onClick={() => {
                            setBrowseCategory(category)
                            setImportStep('folder')
                          }}
                          role="radio"
                          type="button"
                        >
                          <span>{categoryLabel(category)}</span>
                          <small>
                            {library.filter((series) => series.category === category).length}{' '}
                            {language === 'de' ? 'Titel' : 'titles'}
                          </small>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}

                {importStep === 'folder' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepFolder}</span>
                      <h4>{text.importFolderTitle}</h4>
                      <p>{text.importFolderBody}</p>
                    </div>

                    <div className="import-storage-strip">
                      <span>{text.importStorage}</span>
                      <div className="import-storage-options">
                        {rootOptions.map((root) => (
                          <button
                            className={`import-storage-option${selectedRootId === root.id ? ' import-storage-option--active' : ''}`}
                            disabled={adminBusy || scanIsActive}
                            key={root.id}
                            onClick={() => {
                              setSelectedRootId(root.id)
                              setBrowsePath('')
                              setManualFolderPath('')
                            }}
                            type="button"
                          >
                            <strong>{rootTitle(root)}</strong>
                            <small>{rootSubtitle(root)}</small>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="folder-browser">
                      <div className="folder-browser__bar">
                        <div>
                          <span>{text.importCurrentPath}</span>
                          <strong>{currentFolderLabel}</strong>
                        </div>
                        <button
                          className="ghost-button ghost-button--small"
                          disabled={!selectedRootId || browsePath === '' || scanIsActive}
                          onClick={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}
                          type="button"
                        >
                          <AppIcon name="up" />
                          {text.browseUp}
                        </button>
                      </div>

                      <div className="folder-browser__list">
                        {directoryListing.directories.length ? (
                          directoryListing.directories.map((directory) => (
                            <button
                              className="folder-browser__item"
                              key={directory.relativePath}
                              onClick={() => setBrowsePath(directory.relativePath)}
                              type="button"
                            >
                              <div>
                                <strong>{directory.name}</strong>
                                <p>{directory.relativePath}</p>
                              </div>
                              <span>
                                <AppIcon name="folder" />
                                {text.openFolder}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="folder-browser__empty">{text.folderBrowserEmpty}</p>
                        )}
                      </div>
                    </div>

                    <details className="import-storage-details">
                      <summary>{text.importStorageDetails}</summary>
                      <dl className="detail-list">
                        <div>
                          <dt>{text.importStorage}</dt>
                          <dd>{selectedRoot ? `${rootTitle(selectedRoot)} - ${selectedRoot.path}` : text.sourceRoots}</dd>
                        </div>
                        <div>
                          <dt>{text.selectedFolder}</dt>
                          <dd>{selectedFolderDisplayPath || '/'}</dd>
                        </div>
                      </dl>
                      <form className="admin-form" onSubmit={handleUseManualFolderPath}>
                        <label>
                          <span>{text.folderPathInput}</span>
                          <div className="admin-inline-control">
                            <input
                              autoCapitalize="none"
                              autoCorrect="off"
                              onChange={(event) => setManualFolderPath(event.target.value)}
                              placeholder={text.folderPathPlaceholder}
                              spellCheck={false}
                              value={manualFolderPath}
                            />
                            <button className="ghost-button" disabled={!selectedRoot || adminBusy || scanIsActive} type="submit">
                              {text.useFolderPath}
                            </button>
                          </div>
                        </label>
                      </form>
                    </details>

                    <div className="import-actions">
                      <button className="ghost-button" onClick={() => setImportStep('type')} type="button">
                        <AppIcon name="back" />
                        {text.importBack}
                      </button>
                      <button
                        className="primary-button"
                        disabled={!canReviewFolder}
                        onClick={() => setImportStep('review')}
                        type="button"
                      >
                        {text.importReviewAction}
                      </button>
                    </div>
                    {!canReviewFolder ? <p className="helper-text">{text.importOpenFolderFirst}</p> : null}
                  </section>
                ) : null}

                {importStep === 'review' ? (
                  <section className="import-step-panel">
                    <div className="import-step-panel__header">
                      <span>{text.importStepReview}</span>
                      <h4>{text.importReviewTitle}</h4>
                      <p>{selectedFolderAlreadyLinked ? text.importAlreadyLinkedHelp : text.importReviewBody}</p>
                    </div>
                    <div className="import-review-card">
                      <div>
                        <span>{text.folderCategory}</span>
                        <strong>{categoryLabel(browseCategory)}</strong>
                      </div>
                      <div>
                        <span>{text.selectedFolder}</span>
                        <strong>{getFolderLeafLabel(directoryListing.currentPath)}</strong>
                        <p>{selectedFolderDisplayPath || currentFolderLabel}</p>
                      </div>
                      <div>
                        <span>{text.importStorage}</span>
                        <strong>{selectedRoot ? rootTitle(selectedRoot) : text.sourceRoots}</strong>
                      </div>
                    </div>
                    <div className="import-actions">
                      <button className="ghost-button" onClick={() => setImportStep('folder')} type="button">
                        <AppIcon name="back" />
                        {text.importBack}
                      </button>
                      <button
                        className="primary-button"
                        disabled={!canReviewFolder || !selectedRootId || adminBusy || scanIsActive || selectedFolderAlreadyLinked}
                        onClick={() => void handleLinkCurrentFolder()}
                        type="button"
                      >
                        {selectedFolderAlreadyLinked ? text.folderAlreadyLinked : text.addAndScanFolder}
                      </button>
                    </div>
                  </section>
                ) : null}
              </div>

              <aside className="import-existing">
                <div className="import-existing__header">
                  <div>
                    <span>{text.linkedFolderProgress}</span>
                    <h4>{text.importExistingTitle}</h4>
                  </div>
                  <button className="ghost-button ghost-button--small" disabled={adminBusy || scanIsActive} onClick={() => void handleRunScan()} type="button">
                    <AppIcon name="refresh" />
                    {text.refreshMetadata}
                  </button>
                </div>
                <div className="import-existing__list">
                  {linkedSourceFolders.map((folder) => (
                    <div className="source-folder-card" key={folder.id}>
                      <button
                        aria-label={`${text.unlinkFolder}: ${folder.path}`}
                        className="admin-row__dismiss"
                        disabled={adminBusy || scanIsActive}
                        onClick={() => void handleUnlinkSourceFolder(folder.id)}
                        title={text.unlinkFolder}
                        type="button"
                      >
                        <AppIcon name="close" />
                      </button>
                      <div className="source-folder-card__main">
                        <strong>{getFolderLeafLabel(folder.relativePath) || categoryLabel(folder.category)}</strong>
                        <p>{folder.items} - {folder.status} - {formatRelativeTime(folder.lastScanAt, language)}</p>
                        <small>{folder.path}</small>
                      </div>
                      <div className="source-folder-card__controls">
                        <label>
                          <span>{text.changeFolderCategory}</span>
                          <select
                            className="admin-select admin-select--compact"
                            disabled={adminBusy || scanIsActive}
                            onChange={(event) => void handleUpdateSourceCategory(folder.id, event.target.value as CategoryId)}
                            value={folder.category}
                          >
                            {sourceCategoryOptions(folder.category).map((category) => (
                              <option key={category} value={category}>
                                {categoryLabel(category)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="ghost-button ghost-button--small"
                          disabled={adminBusy || scanIsActive}
                          onClick={() => void handleRunScan(folder.id)}
                          type="button"
                        >
                          <AppIcon name="refresh" />
                          {text.rescanFolder}
                        </button>
                      </div>
                    </div>
                  ))}
                  {!linkedSourceFolders.length ? (
                    <p className="folder-browser__empty">{text.importExistingEmpty}</p>
                  ) : null}
                </div>
              </aside>
            </div>
          </article>

          <details className="panel panel--padded advanced-roots" open={!hasManagedRoot}>
            <summary>{text.advancedRoots}</summary>
            {hasManagedRoot ? <p>{text.configuredRootHelp}</p> : null}
            <form className="admin-form" onSubmit={handleAddMountedRoot}>
              <label>
                <span>{text.mountedRootLabel}</span>
                <input
                  onChange={(event) => setRootLabel(event.target.value)}
                  value={rootLabel}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>{text.mountedRootPath}</span>
                <input
                  onChange={(event) => setRootPath(event.target.value)}
                  value={rootPath}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <button className="primary-button" disabled={adminBusy || scanIsActive} type="submit">
                {text.addMountedRoot}
              </button>
            </form>
            <div className="admin-list">
              {sourceRoots.map((root) => (
                <div className="admin-row admin-row--dismissible" key={root.id}>
                  <button
                    aria-label={
                      root.managed
                        ? `${text.configuredRootLocked} ${root.path}`
                        : `${text.unlinkRoot}: ${root.path}`
                    }
                    className="admin-row__dismiss"
                    disabled={root.managed || adminBusy || scanIsActive}
                    onClick={() => void handleUnlinkRoot(root.id)}
                    title={root.managed ? text.configuredRootLocked : text.unlinkRoot}
                    type="button"
                  >
                    <AppIcon name="close" />
                  </button>
                  <div>
                    <strong>{root.label}</strong>
                    <p>{root.path}</p>
                  </div>
                  <span>{root.note}</span>
                </div>
              ))}
            </div>
          </details>

          <article className="panel panel--padded">
            <div className="panel__header">
              <h3>{text.users}</h3>
              <span>Open signup enabled</span>
            </div>
            <div className="admin-list">
              {(appState?.users || []).map((user) => (
                <div className="admin-row" key={user.id}>
                  <div>
                    <strong>{user.name}</strong>
                    <p>{user.role}</p>
                  </div>
                  <div className="admin-row__meta">
                    <span>{user.status}</span>
                    <button
                      className="ghost-button ghost-button--small"
                      onClick={() => void handleResetPassword(user.id)}
                      type="button"
                    >
                      {text.resetPassword}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </article>

          {renderMetadataReview()}
          {renderMetadataEditor()}
        </section>
        {renderScanLog()}
      </div>
    )
  }

  if ((bootLoading || (authenticated && !appState)) && !appState) {
    const loadingCopy =
      authenticated && stateLoading
        ? 'Restoring your session and loading your library.'
        : stateError || 'Preparing the real backend-backed workspace.'

    return (
      <div className="auth-shell">
        <section className="auth-showcase">
          <div className="section-kicker">{text.demoTag}</div>
          <h1>{text.loading}</h1>
          <p>{loadingCopy}</p>
        </section>
      </div>
    )
  }

  if (!authenticated) {
    const authSeriesPreview = visibleLibrary.slice(0, 4)

    return (
      <div className="auth-shell">
        <section className="auth-showcase">
          <div className="section-kicker">{text.authEyebrow}</div>
          <h1>{text.authTitle}</h1>
          <p>{text.authBody}</p>

          <div className="auth-feature-grid">
            <article className="auth-feature">
              <strong>{text.featureBookmarks}</strong>
              <span>
                {text.nav.bookmarks}, {text.nav.manga}, {text.nav.novels}, {text.nav.books}, {text.nav.magazines}
              </span>
            </article>
            <article className="auth-feature">
              <strong>{text.featurePlayer}</strong>
              <span>Series overview, entries, comments, then immersive reader</span>
            </article>
            <article className="auth-feature">
              <strong>{text.featureAdmin}</strong>
              <span>Mounted roots, folder browsing, incremental scanning, metadata queue</span>
            </article>
          </div>

          <div className="auth-poster-row">
            {authSeriesPreview.map((series) => (
              <div key={series.id}>{renderPoster(series, true, false)}</div>
            ))}
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-panel__top">
            <span className="section-kicker">{text.demoTag}</span>
            <div className="segmented-control">
              <button
                className={authMode === 'login' ? 'is-active' : ''}
                onClick={() => setAuthMode('login')}
                type="button"
              >
                {text.signIn}
              </button>
              <button
                className={authMode === 'signup' ? 'is-active' : ''}
                onClick={() => setAuthMode('signup')}
                type="button"
              >
                {text.createAccount}
              </button>
            </div>
          </div>

          <form className="auth-form" onSubmit={handleAuth}>
            <label>
              <span>{text.username}</span>
              <input
                autoComplete="username"
                name="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>{text.password}</span>
              <input
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                name="password"
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            {authError && <p className="auth-error">{authError}</p>}
            {stateError && <p className="auth-error">{stateError}</p>}

            <button className="primary-button primary-button--wide" disabled={authBusy} type="submit">
              {text.authAction}
            </button>
          </form>

          <div className="auth-panel__footer">
            <span className="chip chip--accent">
              {text.adminBootstrap}: {bootstrapState?.bootstrapAdmin || 'admin'}
            </span>
            <div className="language-toggle">
              <button
                className={language === 'en' ? 'is-active' : ''}
                onClick={() => setLanguage('en')}
                type="button"
              >
                EN
              </button>
              <button
                className={language === 'de' ? 'is-active' : ''}
                onClick={() => setLanguage('de')}
                type="button"
              >
                DE
              </button>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={`app-shell ${currentView === 'reader' ? 'app-shell--reader' : ''}`}>
      {currentView !== 'reader' && (
      <header className={`topbar ${topbarHidden ? 'topbar--hidden' : ''}`}>
        <button className="brand-lockup" onClick={() => setCurrentView('bookmarks')}>
          <span className="brand-lockup__mark">O</span>
          <span className="brand-lockup__text">{text.brandName}</span>
        </button>

        <div className="topbar__left">
          <div
            className={`search-shell ${searchOpen ? 'is-open' : ''}`}
            onBlurCapture={handleSearchBlur}
            onFocusCapture={() => setSearchOpen(true)}
          >
            <div className="search-bar">
              <button
                aria-label="Open search"
                className="search-bar__toggle"
                onMouseDown={(event) => {
                  event.preventDefault()
                  openSearch()
                }}
                type="button"
              >
                <AppIcon className="search-bar__icon" name="search" />
              </button>
              <input
                ref={searchInputRef}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => setSearchOpen(true)}
                placeholder={text.searchPlaceholder}
                value={searchQuery}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {searchOpen && (
              <div className="search-popover">
                <div className="search-popover__header">
                  <p className="section-kicker">{text.quickResults}</p>
                  <div className="search-popover__header-actions">
                    {searchQuery && (
                      <button
                        className="ghost-button ghost-button--small"
                        onClick={() => {
                          setSearchQuery('')
                          searchInputRef.current?.focus()
                        }}
                        type="button"
                      >
                        <AppIcon name="close" />
                        {text.clearSearch}
                      </button>
                    )}
                    <button className="ghost-button ghost-button--small" onClick={() => setSearchOpen(false)} type="button">
                      <AppIcon name="close" />
                      {text.closeSearch}
                    </button>
                  </div>
                </div>

                <div className="search-popover__scope">
                  {readerScopeOrder.map((scope) => (
                    <button
                      className={`scope-button ${searchScope === scope ? 'is-active' : ''}`}
                      key={scope}
                      onClick={() => setSearchScope(scope)}
                      type="button"
                    >
                      {text.scopes[scope]}
                    </button>
                  ))}
                </div>

                <div className="search-popover__results">
                  {deferredSearch === '' ? (
                    <div className="search-state">{text.searchHint}</div>
                  ) : searchLoading ? (
                    <div className="search-state">Searching...</div>
                  ) : searchPreview.length === 0 ? (
                    <div className="search-state">No matches yet.</div>
                  ) : (
                      searchPreview.map((series) => (
                        <button
                          className="search-result"
                          key={series.id}
                          onClick={() => {
                            void openSeries(series.id)
                            setSearchOpen(false)
                          }}
                          type="button"
                        >
                          {renderPoster(series, true)}
                          <div>
                            <strong>{getSeriesDisplayTitle(series)}</strong>
                            <p>{categoryLabel(series.category)} • {series.progressLabel}</p>
                          </div>
                        </button>
                      ))
                  )}
                </div>
              </div>
            )}
          </div>

          <nav className="window-tabs">
            {[{ id: 'bookmarks' as const, label: text.nav.bookmarks }, ...readerCategoryOrder.map((category) => ({
              id: category,
              label: text.nav[category],
            }))].map((item) => (
              <button
                className={`window-tab ${
                  item.id === 'bookmarks'
                    ? currentView === 'bookmarks'
                      ? 'is-active'
                      : ''
                    : currentView === 'library' && currentCategory === item.id
                      ? 'is-active'
                      : ''
                }`}
                key={item.id}
                onClick={() => {
                  if (item.id === 'bookmarks') {
                    setCurrentView('bookmarks')
                    return
                  }

                  goToLibrary(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar__right">
          <div className="language-toggle language-toggle--header">
            <button
              className={language === 'en' ? 'is-active' : ''}
              onClick={() => setLanguage('en')}
              type="button"
            >
              EN
            </button>
            <button
              className={language === 'de' ? 'is-active' : ''}
              onClick={() => setLanguage('de')}
              type="button"
            >
              DE
            </button>
          </div>

          <button className="profile-pill" onClick={() => setCurrentView('profile')}>
            <span className="profile-pill__avatar">
              {appState?.user?.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="profile-pill__meta">
              {appState?.user?.username}
              <small>{text.profile}</small>
            </span>
          </button>

          {appState?.user?.role === 'admin' && (
            <button className="ghost-button" onClick={() => setCurrentView('admin')}>
              <AppIcon name="admin" />
              {text.admin}
            </button>
          )}
          <button className="ghost-button" onClick={() => void handleLogout()}>
            <AppIcon name="logout" />
            {text.logout}
          </button>
          <button className="mobile-top-action" onClick={openSearch} type="button" aria-label={text.searchAction}>
            <AppIcon name="search" />
          </button>
        </div>
      </header>
      )}

      <main className="main-shell">
        {currentView === 'admin' && (
          <section className="page-heading">
            <div>
              <p className="section-kicker">{text.demoTag}</p>
              <h1>{pageTitle}</h1>
              <p>{pageBody}</p>
            </div>
            <div className="chip-row">
              <span className="chip chip--accent">{text.scanMode}</span>
              <span className="chip">
                {text.sourceFolders}: {appState?.scanSummary.sourceFolderCount || 0}
              </span>
              <span className="chip">
                {text.lastScan}: {formatRelativeTime(appState?.scanSummary.lastScanAt || null, language)}
              </span>
            </div>
          </section>
        )}

        {stateError && authenticated && <article className="panel panel--padded global-error">{stateError}</article>}

        {currentView === 'bookmarks' && renderBookmarks()}
        {currentView === 'library' && renderLibrary()}
        {currentView === 'search' && renderSearchPage()}
        {currentView === 'series' && renderSeries()}
        {currentView === 'reader' && renderReader()}
        {currentView === 'creator' && renderCreator()}
        {currentView === 'profile' && renderProfile()}
        {currentView === 'admin' && renderAdmin()}
      </main>

      {currentView !== 'reader' && (
        <nav className="bottom-nav" aria-label="Primary">
          <button
            className={currentView === 'bookmarks' ? 'is-active' : ''}
            onClick={() => {
              setCurrentView('bookmarks')
              setSearchOpen(false)
            }}
            type="button"
          >
            <AppIcon name="library" />
            <span>{text.mobileNav.library}</span>
          </button>
          <button
            className={['library', 'series', 'creator'].includes(currentView) ? 'is-active' : ''}
            onClick={() => {
              goToLibrary(currentCategory)
              setSearchOpen(false)
            }}
            type="button"
          >
            <AppIcon name="discover" />
            <span>{text.mobileNav.discover}</span>
          </button>
          <button
            className={currentView === 'search' ? 'is-active' : ''}
            onClick={() => {
              setCurrentView('search')
              setSearchOpen(false)
            }}
            type="button"
          >
            <AppIcon name="search" />
            <span>{text.mobileNav.search}</span>
          </button>
          <button
            className={currentView === 'profile' || currentView === 'admin' ? 'is-active' : ''}
            onClick={() => {
              setCurrentView('profile')
              setSearchOpen(false)
            }}
            type="button"
          >
            <AppIcon name="profile" />
            <span>{text.mobileNav.profile}</span>
          </button>
        </nav>
      )}
    </div>
  )
}

export default App
