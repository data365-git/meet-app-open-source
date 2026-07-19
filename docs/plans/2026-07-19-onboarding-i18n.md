# Onboarding i18n — ready-to-apply catalog + wiring map (authored 2026-07-19, session m)

> **Why this file exists:** the owner said "hammasini qil". I read all 8 onboarding components and
> authored the complete uz/en/ru catalog below — then the elicitation gate blocked the first edit
> pending ONE owner answer (see BLOCKER). Without this file that work dies on `/clear` and costs a
> full re-derivation. **Nothing here has been applied yet.**

## BLOCKER — one owner word decides the scope

The onboarding wizard's step 4, "Invite your team", is in reality a **Pro/Stripe pricing page**
($8.16/user annual, $12 monthly, checkout via `/api/settings/billing/subscribe`). This is upstream
Cap SaaS monetization; ustoz is a self-hosted internal tool for the owner's IT team, so asking his
staff to pay is probably wrong. Options put to him (unanswered):

| answer | meaning |
|---|---|
| `tarjima` | translate it too — Uzbek labels, payment buttons stay |
| `tegma` | leave that page English; translate the other 4 steps |
| `yashir` | drop the step from the wizard entirely (arguably correct for self-hosted) |

Steps 1,2,3,5 + chrome (Base/Bottom/Stepper) get translated **regardless** of the answer.

## Files (all under `apps/web/app/(org)/onboarding/`)

Every one is `"use client"` → use **`useTranslations("onboarding")`** from `next-intl`, NOT the
server `getTranslations`. (`DownloadPage.tsx` lacks the directive but renders inside a client
boundary and already uses `useRouter`; add `"use client"` if the hook complains.)

Insert the new namespace at the TOP of each `apps/web/messages/{uz,en,ru}.json`, anchored before
`"common": {` — that anchor is unique and at file start in all three.

## Wiring map — literal → key

| file | literal today | key |
|---|---|---|
| `components/Base.tsx` | `Back` | `back` |
| `WelcomePage.tsx` | title `Welcome to data365` | `welcomeTitle` |
| | desc `Let's get you started` | `welcomeDescription` |
| | placeholder `First name` | `firstName` |
| | placeholder `Last name (optional)` | `lastNameOptional` |
| | button `Continue` | `continue` |
| | toast `An error occurred, please try again` | `errorGeneric` |
| `Bottom.tsx` | `Sign out` | `signOut` |
| | `Skipping...` | `skipping` |
| | `Skip to dashboard` | `skipToDashboard` |
| | toast (same) | `errorGeneric` |
| `Stepper.tsx` | `Welcome` | `stepWelcome` |
| | `Organization Setup` | `stepOrganization` |
| | `Custom Domain` | `stepCustomDomain` |
| | `Invite your team` | `stepInviteTeam` |
| | `Download` | `stepDownload` |
| | `Step` (mobile "Step 1/5") | `stepLabel` |
| `OrganizationSetupPage.tsx` | title `Organization Setup` | `orgTitle` |
| | desc `Let's get your dashboard setup with your organization` | `orgDescription` |
| | placeholder `Organization Name` | `orgNamePlaceholder` |
| | default `${firstName}'s organization` | `orgDefaultName` (param `{name}`) |
| | `Organization Logo` | `orgLogo` |
| | `Upload Image` | `uploadImage` |
| | `Recommended size: 120x120` | `recommendedSize` |
| | `Create Organization` | `createOrganization` |
| `CustomDomainPage.tsx` | title `Custom Domain` | `customDomainTitle` |
| | desc w/ inline span | `customDomainDescription` via **`t.rich`**, tag `<domain>` |
| | `Upgrade to Pro` | `upgradeToPro` |
| | `Skip` | `skip` |
| `InviteTeamPage.tsx` | title `Invite your team` | `inviteTitle` |
| | desc `Invite members of your team…share Caps together` | `inviteDescription` |
| | `Monthly` | `billingMonthly` |
| | `Annual (save 32%)` | `billingAnnual` |
| | `per user, billed annually` | `perUserBilledAnnually` |
| | `per user, billed monthly` | `perUserBilledMonthly` |
| | `Per user` | `perUser` |
| | `Get Started` | `getStarted` |
| | `Skip` | `skip` |
| | toast `Unable to start checkout. Please try again.` | `checkoutError` |
| | toast `You are already on the Pro plan` | `alreadyPro` |
| | toast `Something went wrong. Please try again.` | `somethingWrong` |
| `DownloadPage.tsx` | `Install data365` | `installTitle` |
| | `Start recording beautiful screen recordings today` | `installSubtitle` |
| | `Instant Mode` / its description | `instantMode` / `instantModeDesc` |
| | `Studio Mode` / its description | `studioMode` / `studioModeDesc` |
| | `Install the browser extension` | `installExtension` |
| | `Continue` | `continue` |

### Deliberate carve-outs (owner's standing rule: keep English where no clean Uzbek exists)
1. `CustomDomainPage` description embeds `cap.yourdomain.com` in a styled `<span>` → must use
   `t.rich("customDomainDescription", { domain: (c) => <span className="font-medium text-blue-500">{c}</span> })`.
2. `InviteTeamPage`'s **secondary** price line — `or, <NumberFlow/> {per user, | for <NumberFlow/> users,} billed monthly|annually`
   — stays **English**. Inline NumberFlow interpolation + Uzbek word order makes it fragile, and it
   sits on a Stripe page of doubtful relevance here. The PRIMARY billing text
   (`perUserBilledAnnually/Monthly`) IS translated.
3. `aria-label`s (`Decrease user count`, `Increase user count`, `Billing Cycle`) — translate only if
   the owner wants; not in the catalog below.

## Blast-radius (checked this session)
- No onboarding file currently imports next-intl → adding the hook is additive, no existing keys move.
- `orgDefaultName` changes a *pre-filled input value*, not stored data; user can still edit it.
- Stepper matches `currentStep === step.name` **by string**. ⚠️ Once names come from `t()`, both the
  `currentStep` useMemo and the `steps[].name` must use the SAME `t()` calls, or the active-step
  highlight silently breaks. This is the one real trap in the whole change — verify the highlight.
- Unrelated but adjacent, verified: `/dashboard/shared-caps` has NO route and exactly ONE reference
  (`app/(org)/dashboard/_components/Navbar/Top.tsx:44`, a pathname→title map entry) with no link to
  it anywhere → deleting that line is safe. See `qa-evidence/shared-caps-finding.md`.

## Verification after applying
1. `pnpm --filter @cap/web exec tsc --noEmit` → 0.
2. `node -e` parse all 3 message files; assert `onboarding.stepOrganization` exists in each.
3. Local dev: walk `/onboarding/welcome` → `/organization-setup` → `/custom-domain` →
   `/invite-team` → `/download`; confirm Uzbek copy AND that the Stepper highlights the current step
   (the trap above). Note: local `.env` DATABASE_URL points at a DEAD Railway MySQL, so authed pages
   may not render locally — use the minted-session recipe in `docs/qa/SESSION_INJECTION_NOTES.md`
   against prod after deploy instead.
4. `grep -rn "Welcome to data365\|Skip to dashboard\|Organization Setup" apps/web/app/\(org\)/onboarding` → 0 hits.

---

# THE CATALOG

## uz.json — `"onboarding"`
```json
"onboarding": {
  "back": "Orqaga",
  "errorGeneric": "Xatolik yuz berdi, qayta urinib ko'ring",
  "welcomeTitle": "data365'ga xush kelibsiz",
  "welcomeDescription": "Keling, boshlaymiz",
  "firstName": "Ism",
  "lastNameOptional": "Familiya (ixtiyoriy)",
  "continue": "Davom etish",
  "signOut": "Chiqish",
  "skipping": "O'tkazilmoqda...",
  "skipToDashboard": "Boshqaruv paneliga o'tish",
  "stepWelcome": "Xush kelibsiz",
  "stepOrganization": "Tashkilotni sozlash",
  "stepCustomDomain": "Maxsus domen",
  "stepInviteTeam": "Jamoani taklif qilish",
  "stepDownload": "Yuklab olish",
  "stepLabel": "Qadam",
  "orgTitle": "Tashkilotni sozlash",
  "orgDescription": "Keling, boshqaruv panelini tashkilotingiz bilan sozlaymiz",
  "orgNamePlaceholder": "Tashkilot nomi",
  "orgDefaultName": "{name} tashkiloti",
  "orgLogo": "Tashkilot logotipi",
  "uploadImage": "Rasm yuklash",
  "recommendedSize": "Tavsiya etilgan o'lcham: 120x120",
  "createOrganization": "Tashkilot yaratish",
  "customDomainTitle": "Maxsus domen",
  "customDomainDescription": "Pro foydalanuvchilar ulashiladigan yozuv havolalari uchun maxsus domen sozlashi mumkin, masalan <domain>cap.yourdomain.com</domain>",
  "upgradeToPro": "Pro'ga o'tish",
  "skip": "O'tkazib yuborish",
  "inviteTitle": "Jamoangizni taklif qiling",
  "inviteDescription": "Jamoa a'zolaringizni tashkilotingizga qo'shing va yozuvlarni birga ulashing",
  "billingMonthly": "Oylik",
  "billingAnnual": "Yillik (32% tejang)",
  "perUserBilledAnnually": "har foydalanuvchi uchun, yillik to'lov",
  "perUserBilledMonthly": "har foydalanuvchi uchun, oylik to'lov",
  "perUser": "Har foydalanuvchi",
  "getStarted": "Boshlash",
  "checkoutError": "To'lovni boshlab bo'lmadi. Qayta urinib ko'ring.",
  "alreadyPro": "Siz allaqachon Pro tarifidasiz",
  "somethingWrong": "Xatolik yuz berdi. Qayta urinib ko'ring.",
  "installTitle": "data365'ni o'rnating",
  "installSubtitle": "Bugun chiroyli ekran yozuvlarini yozishni boshlang",
  "instantMode": "Tezkor rejim",
  "instantModeDesc": "data365 yozuvni kichik bo'laklarda yuklab borgan holda yozing. To'xtatganingizda, yuklashning ko'p qismi allaqachon bajarilgani uchun havola ancha tez tayyor bo'ladi. AI tahlili faqat siz tugmani bosganingizda boshlanadi.",
  "studioMode": "Studiya rejimi",
  "studioModeDesc": "Mahalliy tahrirlash, maxsus fonlar va eksport imkoniyatlari bilan professional yozuvlar. Brendingizni aks ettiruvchi mukammal demolar, qo'llanmalar yoki taqdimotlar kerak bo'lganda.",
  "installExtension": "Brauzer kengaytmasini o'rnatish"
}
```

## en.json — `"onboarding"`
```json
"onboarding": {
  "back": "Back",
  "errorGeneric": "An error occurred, please try again",
  "welcomeTitle": "Welcome to data365",
  "welcomeDescription": "Let's get you started",
  "firstName": "First name",
  "lastNameOptional": "Last name (optional)",
  "continue": "Continue",
  "signOut": "Sign out",
  "skipping": "Skipping...",
  "skipToDashboard": "Skip to dashboard",
  "stepWelcome": "Welcome",
  "stepOrganization": "Organization Setup",
  "stepCustomDomain": "Custom Domain",
  "stepInviteTeam": "Invite your team",
  "stepDownload": "Download",
  "stepLabel": "Step",
  "orgTitle": "Organization Setup",
  "orgDescription": "Let's get your dashboard setup with your organization",
  "orgNamePlaceholder": "Organization Name",
  "orgDefaultName": "{name}'s organization",
  "orgLogo": "Organization Logo",
  "uploadImage": "Upload Image",
  "recommendedSize": "Recommended size: 120x120",
  "createOrganization": "Create Organization",
  "customDomainTitle": "Custom Domain",
  "customDomainDescription": "Pro users can set up a custom domain to access their shareable recording links, e.g. <domain>cap.yourdomain.com</domain>",
  "upgradeToPro": "Upgrade to Pro",
  "skip": "Skip",
  "inviteTitle": "Invite your team",
  "inviteDescription": "Invite members of your team to join your organization and share recordings together",
  "billingMonthly": "Monthly",
  "billingAnnual": "Annual (save 32%)",
  "perUserBilledAnnually": "per user, billed annually",
  "perUserBilledMonthly": "per user, billed monthly",
  "perUser": "Per user",
  "getStarted": "Get Started",
  "checkoutError": "Unable to start checkout. Please try again.",
  "alreadyPro": "You are already on the Pro plan",
  "somethingWrong": "Something went wrong. Please try again.",
  "installTitle": "Install data365",
  "installSubtitle": "Start recording beautiful screen recordings today",
  "instantMode": "Instant Mode",
  "instantModeDesc": "Record while data365 uploads in small chunks. When you stop, the link can be ready much faster because most of the upload already happened. AI analysis starts only when you press the button.",
  "studioMode": "Studio Mode",
  "studioModeDesc": "Professional recordings with local editing, custom backgrounds, and export options. When you need pixel-perfect demos, tutorials, or presentations that represent your brand.",
  "installExtension": "Install the browser extension"
}
```

## ru.json — `"onboarding"`
```json
"onboarding": {
  "back": "Назад",
  "errorGeneric": "Произошла ошибка, попробуйте ещё раз",
  "welcomeTitle": "Добро пожаловать в data365",
  "welcomeDescription": "Давайте начнём",
  "firstName": "Имя",
  "lastNameOptional": "Фамилия (необязательно)",
  "continue": "Продолжить",
  "signOut": "Выйти",
  "skipping": "Пропуск...",
  "skipToDashboard": "Перейти к панели",
  "stepWelcome": "Добро пожаловать",
  "stepOrganization": "Настройка организации",
  "stepCustomDomain": "Свой домен",
  "stepInviteTeam": "Пригласите команду",
  "stepDownload": "Загрузка",
  "stepLabel": "Шаг",
  "orgTitle": "Настройка организации",
  "orgDescription": "Давайте настроим панель для вашей организации",
  "orgNamePlaceholder": "Название организации",
  "orgDefaultName": "Организация {name}",
  "orgLogo": "Логотип организации",
  "uploadImage": "Загрузить изображение",
  "recommendedSize": "Рекомендуемый размер: 120x120",
  "createOrganization": "Создать организацию",
  "customDomainTitle": "Свой домен",
  "customDomainDescription": "Pro-пользователи могут настроить свой домен для ссылок на записи, например <domain>cap.yourdomain.com</domain>",
  "upgradeToPro": "Перейти на Pro",
  "skip": "Пропустить",
  "inviteTitle": "Пригласите команду",
  "inviteDescription": "Пригласите участников команды в вашу организацию и делитесь записями вместе",
  "billingMonthly": "Ежемесячно",
  "billingAnnual": "Годовой (скидка 32%)",
  "perUserBilledAnnually": "за пользователя, оплата за год",
  "perUserBilledMonthly": "за пользователя, оплата за месяц",
  "perUser": "За пользователя",
  "getStarted": "Начать",
  "checkoutError": "Не удалось начать оплату. Попробуйте ещё раз.",
  "alreadyPro": "У вас уже есть план Pro",
  "somethingWrong": "Что-то пошло не так. Попробуйте ещё раз.",
  "installTitle": "Установите data365",
  "installSubtitle": "Начните записывать красивые скринкасты уже сегодня",
  "instantMode": "Мгновенный режим",
  "instantModeDesc": "Записывайте, пока data365 загружает данные небольшими частями. Когда вы остановитесь, ссылка будет готова гораздо быстрее, потому что большая часть уже загружена. AI-анализ запускается только по нажатию кнопки.",
  "studioMode": "Студийный режим",
  "studioModeDesc": "Профессиональные записи с локальным редактированием, своими фонами и опциями экспорта. Когда нужны идеальные демо, туториалы или презентации, отражающие ваш бренд.",
  "installExtension": "Установить расширение для браузера"
}
```
