# Language

ProxyHub supports English (`en`) and Simplified Chinese (`zh-CN`). Change the language on the
login page, in the application header/sidebar, or under Settings. The interface updates without a
page reload.

The choice is stored in browser local storage as `proxyhub.locale`; it is not synchronized to the
administrator account. When no choice exists, browsers reporting `zh`, `zh-CN`, or `zh-Hans` use
Simplified Chinese. Other browsers use English. Missing translations safely fall back to English.

Dates, relative times, numbers, percentages, durations, and file sizes use the active locale and
browser time zone. Technical identifiers such as ports, UUIDs, hashes, Git SHAs, and error codes
are not localized.
