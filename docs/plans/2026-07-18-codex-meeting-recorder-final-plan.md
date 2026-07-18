# Ustoz Meeting Recorder — chuqur tekshiruv va Claude tuzatish rejasi

Sana: 2026-07-18

## Qisqa hukm

Muammo hali hal bo‘lmaganining sababi recorderning asosiy motori emas. Xatolar kirish va chiqish chegaralarida qolgan:

1. “Permanently discard” hozir haqiqiy o‘chirish emas. Extension `/api/video/delete` ni chaqiradi; server esa yozuvni yetti kunlik Trash holatiga o‘tkazadi.
2. Internet yo‘q paytda discard qilinsa, lokal upload izi o‘chadi, ammo serverdagi ma’lumotni keyin qayta o‘chirish uchun mustahkam navbat qolmaydi.
3. `Entire Screen` tanlash hozir faqat Chrome’ga berilgan tavsiya. Foydalanuvchi tab yoki window tanlasa, app natijani tekshirmaydi.
4. Pause/Resume ichki tasdiqlashi yaxshilangan, lekin popup xato javobini kutmaydi. Shuning uchun UI “paused” deb o‘ylashi, recorder esa davom etishi mumkin. Doim ochiq recorder sahifasida Pause/Resume tugmalari ham yo‘q.

## Hozirgi ishning holati

Joriy yozilayotgan diffda foydali tuzatishlar bor:

- tab-only audio ishlamasa video-only yozishga yashirin o‘tish olib tashlangan;
- audio track holatini tekshirish va warning qo‘shilgan;
- service worker Pause/Resume holatini recorder tasdiqlagandan keyin o‘zgartiradigan bo‘lgan;
- uploadni fonda davom ettirish va butunlay discard qilish ajratilgan;
- meeting recorder matni aniqroq qilingan.

Joriy extension testlari 59/59 o‘tdi va build o‘tdi. Lekin bu testlar yuqoridagi server + offline + Chrome chegaralarini hali isbotlamaydi.

## Claude bajaradigan tartib

### 1. Haqiqiy, qayta chaqirilsa ham xavfsiz permanent discard

- Alohida server endpoint yaratiladi.
- Avval foydalanuvchi shu recording egasi ekanligi tekshiriladi.
- Keyin multipart va R2 fayllari o‘chiriladi.
- Eng oxirida database yozuvlari o‘chiriladi.
- Bir xil so‘rov ikki marta kelsa ham xato yoki qoldiq chiqarmasligi kerak.
- Storage o‘chirish ishlamasa, database egasi yozuvi saqlanadi — shunda keyin qayta urinish mumkin.
- Soft-delete endpoint bu oqimda umuman ishlatilmaydi.

### 2. Offline discard uchun mustahkam navbat

- Server o‘chirish ishlamaguncha extension storage’da bitta `discard` vazifasi qoladi.
- Chrome restartdan keyin uni avtomatik davom ettiradi.
- Takroriy click yoki restart duplicate vazifa yaratmaydi.
- UI faqat ikki rost holatdan birini ko‘rsatadi: `Deleted` yoki `Delete queued; will retry automatically`.
- Eski discard natijasi yangi recording holatini buzmaydi.

### 3. Audio kafolatini tugatish

- Tab-only rejimda audio yo‘q, tugagan yoki ishga yaroqsiz bo‘lsa yozish boshlanmaydi.
- Full-screen rejimdagi oldindan kelishilgan istisno saqlanadi: foydalanuvchi aniq tasdiqlasa yozish boshlanadi, lekin warning recording tugaguncha turadi.
- Audio uzilsa bir marta warning, qaytsa recovery ko‘rsatiladi.
- Chrome speaker-mute qanday signal berishi real Meet’da tekshirilmaguncha “ishlaydi” deb yozilmaydi.

### 4. Rost Pause/Resume

- Popup javobni kutadi.
- Recorder tasdiqlamasa label va holat o‘zgarmaydi; ko‘rinadigan xato chiqadi.
- Doim ochiq recorder sahifasiga Pause/Resume qo‘shiladi.
- Ikkala UI bir xil service-worker holatini o‘qiydi.
- Pause vaqtida timer muzlaydi; resume o‘sha recordingni davom ettiradi.

### 5. `Entire Screen`ni haqiqiy tekshirish

- Chrome picker qaytargan video track’ning `displaySurface` qiymati tekshiriladi.
- Meeting rejimida `monitor` bo‘lmasa stream darhol yopiladi va upload boshlanmaydi.
- App `Choose Entire Screen` deb qayta urinishni so‘raydi.
- Oddiy instruction recordingda tab/window tanlash imkoniyati o‘zgarmaydi.

### 6. Kod va real qurilma gate’i

Kod gate’i:

- yangi RED testlar avval xatoni ko‘rsatishi;
- barcha extension testlari;
- server discard testlari;
- extension build;
- root typecheck;
- repo gate;
- EOL va diff tekshiruvi.

Real gate:

1. Ikki kishilik real Google Meet.
2. Remote odam noyob gaplarni aytadi; saqlangan videoda shu gaplar eshitiladi.
3. 10 soniya Pause; remote gapiradi; final videoda shu interval yo‘q va timer muzlaydi.
4. Chrome tab mute/unmute warning real ishlashi tekshiriladi.
5. Offline holatda Stop, Chrome restart, internet qaytadi; video oxirigacha finalize va playback qiladi.
6. Tab-only rejimda remote ovoz qayta tekshiriladi.
7. Offline permanent discard; internet qaytgach dashboard, Trash, database, R2, multipart va extension retry navbatida hech narsa qolmaydi.
8. Meetingda ataylab tab/window tanlanadi; app upload boshlamasdan rad etadi.

Shulardan bittasi o‘tmasa release bloklanadi.

## Claude Code uchun tayyor prompt

Quyidagini Claude Code’ga yuboring:

```text
Work in D:\vibecoding\ustoz-github.

Read AGENTS.md, docs/STATE.md, CODEX_TO_CLAUDE_MEETING_RECORDER_FINAL_FIX_2026-07-18.md, docs/plans/2026-07-18-meeting-recorder-final-hardening.md, and docs/plans/2026-07-15-recorder-resilience-and-one-click.md in that order.

Implement the final meeting-recorder hardening plan exactly in RED-to-GREEN waves. Preserve the current dirty recorder work and all unrelated user changes. Do not reset, checkout, clean, stash, broadly format, replace whole files, commit, push, deploy, or touch production.

The four proved blockers are: permanent discard currently calls a seven-day soft-delete route; offline discard has no durable cleanup retry; full-screen selection is only hinted and not validated; Pause/Resume/discard UI remains partly fire-and-forget and the persistent recorder page lacks Pause/Resume.

Respect the binding product decisions: keep both capture modes; keep the explicit full-screen no-audio waiver with a persistent warning; tab-only fails closed; do not use desktopCapture; do not add audio-energy detection; do not claim tab-strip mute behavior before a real-device proof.

For every wave, first add a focused failing test, capture the failure, make the smallest fix, and rerun the focused and affected suites. Permanent discard must be owner-authorized, storage-first/database-last, idempotent, and durable across offline restart. Pause/Resume UI changes only after recorder acknowledgement. Meeting mode validates returned displaySurface and rejects known non-monitor surfaces before upload initialization.

Run all gates specified in the plan, update docs/STATE.md with facts, and report RED evidence, the minimal diff, GREEN outputs, and remaining device-only claims. Do not say fixed or production-ready until the exact real two-person Meet/device checklist in the plan passes.
```

## Dalil manbalari

- Chrome tab capture: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Media track `muted` ma’nosi: https://www.w3.org/TR/mediacapture-streams/
- Screen picker va `displaySurface`: https://www.w3.org/TR/screen-capture/

## Yakuniy baho

Kod ichidagi 59/59 test va build yaxshi signal, lekin meeting recorder hali production-ready deb bo‘lmaydi. Yuqoridagi server, offline va real Chrome gate’lari ko‘rilmaguncha “hal bo‘ldi” deyish rost bo‘lmaydi.
