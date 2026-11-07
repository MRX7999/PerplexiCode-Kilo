# MCP для security-задач и Parrot OS

Подборка проверена по первичной документации 7 ноября 2026 года; это не рейтинг популярности и не аудит безопасности сторонних серверов. Ниже восемь интеграций для разрешённого анализа кода, зависимостей, веб-приложений, своей сети, бинарных файлов и threat intelligence.

## Границы и подготовка

- **Только разрешённые цели:** заранее согласуйте домены/IP, время, интенсивность и допустимые действия. Добавление MCP не является разрешением на сканирование, загрузку файлов или изменение проектов.
- **Ручная настройка:** все security-карточки каталога являются setup-only. Просмотр карточки или документации не устанавливает пакеты и не запускает сервер; выполнение приведённых команд может загрузить и запустить сторонний код.
- **Parrot OS:** интеграции не тестировались в Parrot VM. «Linux документирован» ниже относится к соответствующему продукту или CLI, а не к сертификации MCP на Parrot.
- **Секреты:** OAuth и синтаксис `${secret:...}` не реализованы, но подстановка `${ENV_VAR}` из окружения поддерживается. IDE также поддерживает SecretStorage для предусмотренных каталогом secret inputs с привязкой к конкретной конфигурации сервера; это не автоматическая настройка восьми ручных security-интеграций. Не вставляйте рабочие ключи в репозиторий, чат или общий `.mcp.json`; для ручных настроек используйте environment placeholders либо поддерживаемый сервером защищённый файл токена.
- **Проверка пакетов:** точные документированные команды Parrot: `apt search <package/text_string>`, `apt show <package>` и `sudo apt install <package>`. Первые две позволяют проверить доступный пакет; последняя устанавливает его и не входит в read-only preflight ниже. ([Parrot Software Management](https://parrotsec.org/docs/configuration/parrot-software-management/))
- **Node.js и uv:** для Node-обёрток выбирайте поддерживаемую LTS-ветку, соответствующую требованиям сервера; у uv есть официальный Linux installer, который следует изучить перед выполнением. Не используйте `sudo pip` и не отключайте системные ограничения Python. ([Node.js releases](https://nodejs.org/en/about/previous-releases), [uv installation](https://docs.astral.sh/uv/getting-started/installation/))

JSON-фрагменты используют оболочку `mcpServers`; абсолютные пути и `<PLACEHOLDER>` необходимо заменить вручную. Где первичный источник даёт CLI, а не JSON, это явно обозначено; шаблон не следует воспринимать как протестированную установку.

### Read-only preflight на Parrot

Сначала посмотрите пути через `command -v`, затем версии только уже установленных инструментов; эти команды не устанавливают пакеты и не задают цель сетевого сканирования. Значение `command -v` документировано Bash, а version flags подтверждены первичными материалами Node.js, uv, Nmap и Java. ([Bash command builtin](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html), [Node.js CLI](https://nodejs.org/api/cli.html), [uv CLI source](https://github.com/astral-sh/uv/blob/main/crates/uv-cli/src/lib.rs), [Nmap version option](https://nmap.org/book/man-misc-options.html), [Java command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html))

```sh
command -v node npx uv uvx nmap java semgrep pcode
if command -v node >/dev/null 2>&1; then node --version; fi
if command -v uv >/dev/null 2>&1; then uv --version; fi
if command -v nmap >/dev/null 2>&1; then nmap --version; fi
if command -v java >/dev/null 2>&1; then java -version; fi
```

Отсутствующая команда означает, что соответствующую предпосылку нужно подготовить вручную по документации продукта; установленная версия должна соответствовать требованиям выбранной интеграции ниже. Не устанавливайте все перечисленные инструменты ради одного MCP и не запускайте весь клиент от root.

## Анализ исходного кода и зависимостей

### Semgrep MCP: SAST

- **Проект:** официальный сервер теперь встроен в [semgrep/semgrep](https://github.com/semgrep/semgrep); старый [semgrep/mcp](https://github.com/semgrep/mcp) архивирован и объявлен deprecated, поэтому `uvx semgrep-mcp` не рекомендуется для новой настройки. ([Current MCP README](https://github.com/semgrep/semgrep/blob/develop/cli/src/semgrep/mcp/README.md), [Migration notice](https://github.com/semgrep/mcp))
- **Назначение и требования:** локальные проверки кода и работа с Semgrep; нужен установленный CLI в `PATH`, а для AppSec Platform дополнительно применяется `SEMGREP_APP_TOKEN`. Linux указан в документации основного CLI, но проверка Parrot MCP не проводилась. ([Semgrep repository](https://github.com/semgrep/semgrep), [MCP README](https://github.com/semgrep/semgrep/blob/develop/cli/src/semgrep/mcp/README.md))
- **Риск:** доступ к исходникам и результатам анализа; основной README заявляет, что код по умолчанию не загружается, однако это не делает все облачные функции offline. Начинайте с отдельного разрешённого проекта и не выдавайте лишний токен. ([Semgrep repository](https://github.com/semgrep/semgrep))

Команда и аргументы приведены в текущем первичном README; оболочка JSON нормализована из примера `servers`. ([MCP configuration](https://github.com/semgrep/semgrep/blob/develop/cli/src/semgrep/mcp/README.md))

```json
{
  "mcpServers": {
    "semgrep": {
      "command": "semgrep",
      "args": ["mcp"]
    }
  }
}
```

### Snyk MCP: зависимости и код

- **Проект:** официальный локальный сервер входит в [snyk/cli](https://github.com/snyk/cli); документация рекомендует Node.js и `npx`, либо ручное подключение установленного Snyk CLI. Для сканирования требуется авторизация Snyk, а Linux имеет официальные standalone binaries. ([MCP setup](https://docs.snyk.io/agent-security/agentic-security-with-snyk-studio/getting-started-with-snyk-studio), [CLI installation](https://docs.snyk.io/snyk-cli/install-or-update-the-snyk-cli))
- **Риск:** локальный MCP имеет доступ к файлам; `npx -y` может автоматически загрузить пакет при запуске, а `@latest` не фиксирует версию. Не считайте интеграцию полностью offline и сначала проверьте правила обработки данных для своего аккаунта. ([MCP setup](https://docs.snyk.io/agent-security/agentic-security-with-snyk-studio/getting-started-with-snyk-studio))

Точный JSON из текущей документации Snyk приведён ниже; в каталоге он остаётся ручным вариантом, не автоматической установкой. ([MCP setup](https://docs.snyk.io/agent-security/agentic-security-with-snyk-studio/getting-started-with-snyk-studio))

```json
{
  "mcpServers": {
    "Snyk": {
      "command": "npx",
      "args": ["-y", "snyk@latest", "mcp", "-t", "stdio"],
      "env": {}
    }
  }
}
```

## Веб-тестирование и сеть

### Burp Suite MCP: официальный PortSwigger

- **Проект:** [PortSwigger/mcp-server](https://github.com/PortSwigger/mcp-server) подключает Burp к AI-клиентам; перед использованием необходимо установить и настроить расширение в Burp, а для stdio нужен Java executable и экспортированный `mcp-proxy-all.jar`. Поддержка Linux документирована у Burp, но MCP на Parrot не проверен. ([Extension README](https://github.com/PortSwigger/mcp-server), [Burp system requirements](https://portswigger.net/burp/documentation/desktop/getting-started/system-requirements))
- **Назначение и риск:** просмотр proxy history, отправка HTTP-запросов, Repeater/Intruder и другие действия; Burp по умолчанию запрашивает подтверждение для запросов и истории. Не включайте auto-approve или инструменты редактирования конфигурации без отдельного решения. ([Extension README](https://github.com/PortSwigger/mcp-server), [Official BApp listing](https://portswigger.net/bappstore/9952290f04ed4f628e624d0aa9dccebc))

JSON повторяет документированный stdio proxy, заменяя описательные placeholders на очевидные абсолютные пути; URL должен совпадать с настройкой расширения. Прямой Streamable HTTP endpoint `http://127.0.0.1:9876/mcp` также документирован, но ниже выбран поставляемый stdio bridge. ([Client configuration](https://github.com/PortSwigger/mcp-server))

```json
{
  "mcpServers": {
    "burp": {
      "command": "/absolute/path/to/burp/java",
      "args": [
        "-jar",
        "/absolute/path/to/mcp-proxy-all.jar",
        "--sse-url",
        "http://127.0.0.1:9876"
      ]
    }
  }
}
```

### ZAP MCP Integration: официальный add-on

- **Проект:** настоящий официальный add-on находится в [zaproxy/zap-extensions, addOns/mcp](https://github.com/zaproxy/zap-extensions/tree/main/addOns/mcp), а не требует случайной community-обёртки; первоначальный анонс отмечал alpha, changelog содержит версию 0.4.0 от 26 августа 2026 года. Для Linux-версии ZAP требуется Java 17+. ([Official announcement](https://www.zaproxy.org/blog/2026-04-02-zap-mcp-server/), [Add-on changelog](https://github.com/zaproxy/zap-extensions/blob/main/addOns/mcp/CHANGELOG.md), [ZAP download](https://www.zaproxy.org/download/))
- **Настройка:** установите MCP Integration через Marketplace, затем откройте Options → MCP Integration и включите сервер; default port `8282`, Secure Only включён по умолчанию. Заголовок имеет точный вид `Authorization: <security-key>`, без автоматически добавленного `Bearer`. ([MCP overview](https://www.zaproxy.org/docs/desktop/addons/mcp-integration/), [MCP options](https://www.zaproxy.org/docs/desktop/addons/mcp-integration/mcp-options/))
- **Риск:** инструменты могут запускать spiders и active scans и читать перехваченный трафик; сервер нельзя выставлять во внешнюю сеть. HTTPS может потребовать доверия к сертификату ZAP; не обходите проблему глобальным отключением TLS-проверки. ([Official announcement](https://www.zaproxy.org/blog/2026-04-02-zap-mcp-server/), [Current security warnings](https://www.zaproxy.org/docs/desktop/addons/mcp-integration/))

Первичная документация не публикует универсальный install JSON: она задаёт endpoint, header и настройки add-on. Ниже именно ручной адаптер этих полей для данного runtime, а не дословный vendor JSON; HTTPS-адрес взят из официального примера и требует соответствующей TLS-настройки. ([Connection example](https://www.zaproxy.org/blog/2026-04-02-zap-mcp-server/), [Header semantics](https://www.zaproxy.org/docs/desktop/addons/mcp-integration/mcp-options/))

```json
{
  "mcpServers": {
    "zap": {
      "type": "http",
      "url": "https://localhost:8282",
      "headers": {
        "Authorization": "${ZAP_SECURITY_KEY}"
      }
    }
  }
}
```

### Nmap MCP: community wrapper

- **Проект:** [creimer808/nmap-mcp](https://github.com/creimer808/nmap-mcp) предоставляет network discovery и анализ hosts/services; необходимы Python 3.11+, системный `nmap`, `uv` для показанного конфига и проверенная локальная копия проекта. README не заявляет тестирование Linux-дистрибутивов или Parrot; это небольшой community-проект без опубликованного в README обязательства поддержки. ([Repository and setup](https://github.com/creimer808/nmap-mcp))
- **Риск:** `nmap-scan` действительно запускает сетевые сканирования; allowlist аргументов и проверки целей не заменяют согласованный scope. Начинайте без повышения привилегий; если режим требует дополнительных прав, пересмотрите режим вручную, а не запускайте весь MCP от root. ([Scanner behavior](https://github.com/creimer808/nmap-mcp))

Точный JSON приведён в README; замените путь на проверенную локальную копию и используйте изолированное Python-окружение при ручной подготовке зависимостей. Не запускайте этот шаблон на чужих сетях. ([MCP configuration](https://github.com/creimer808/nmap-mcp))

```json
{
  "mcpServers": {
    "nmap-mcp": {
      "command": "uv",
      "args": ["--directory", "/path/to/nmap-mcp", "run", "nmap-mcp"]
    }
  }
}
```

## Reverse engineering и threat intelligence

### GhidraMCP: community extension

- **Проект:** [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) предоставляет декомпиляцию и анализ, включая автоматическое переименование методов и данных; текущий README требует Ghidra 12.1.4 и `uv`. Сначала вручную установите соответствующий release extension и включите GhidraMCPPlugin через File → Configure → Developer. ([Setup and capabilities](https://github.com/LaurieWired/GhidraMCP))
- **Совместимость и риск:** Linux поддерживается самой Ghidra, но community MCP не заявляет Parrot-тестирование; это не официальный MCP от NSA. Инструменты способны менять аналитическую базу Ghidra, поэтому работайте с копией проекта и не запускайте исследуемый бинарник для подключения MCP. ([Ghidra project](https://github.com/NationalSecurityAgency/ghidra), [Community MCP](https://github.com/LaurieWired/GhidraMCP))

Точный JSON из README использует загрузку из Git-репозитория при первом запуске; путь к native extension и его версия всё равно требуют ручной подготовки. ([Client configuration](https://github.com/LaurieWired/GhidraMCP))

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/LaurieWired/GhidraMCP",
        "ghidra-mcp",
        "--ghidra-server",
        "http://127.0.0.1:8080/"
      ]
    }
  }
}
```

### Shodan MCP: пассивный OSINT через community server

- **Проект:** [aethrox/shodan-mcp](https://github.com/aethrox/shodan-mcp) требует Node.js 20+, API key и подходящий тариф Shodan; после проверки кода README предлагает clone и `npm install`. В опубликованном списке есть host/search/CVE/DNS/account lookups, но нет инструмента запуска активного сканирования; название репозитория не следует интерпретировать шире этого списка. ([README and tool list](https://github.com/aethrox/shodan-mcp))
- **Риск:** запросы уходят в Shodan и могут расходовать квоту, ключ передаётся процессу через обычную environment variable; кэширования и обработки rate limits нет. Linux/Parrot отдельно не задокументирован, а наличие записи в Shodan не является разрешением проверять найденный узел. ([Limitations and security notes](https://github.com/aethrox/shodan-mcp))

README даёт CLI `node /absolute/path/to/index.js` с `SHODAN_API_KEY`; следующий JSON является явной нормализацией этих полей, а не дословным JSON из источника. В шаблоне дополнительно используется поддерживаемая данным runtime подстановка `${SHODAN_API_KEY}`: переменную необходимо безопасно передать процессу клиента до его запуска, а реальный ключ не сохранять в tracked-файл. ([Registration command](https://github.com/aethrox/shodan-mcp))

```json
{
  "mcpServers": {
    "shodan": {
      "command": "node",
      "args": ["/absolute/path/to/shodan-mcp/index.js"],
      "env": {
        "SHODAN_API_KEY": "${SHODAN_API_KEY}"
      }
    }
  }
}
```

### VirusTotal MCP: официальный VTAI

- **Проект:** [VirusTotal/virustotal-mcp](https://github.com/VirusTotal/virustotal-mcp) документирует Linux, macOS и Windows; для local stdio нужны Python 3.12+, `uv`, пакет `vt-mcp` и VTAI Agent Token в локальном файле. Remote OAuth в текущем runtime не поддержан, поэтому здесь выбран local stdio. ([Official README](https://github.com/VirusTotal/virustotal-mcp), [Client guide](https://github.com/VirusTotal/virustotal-mcp/blob/main/docs/clients.md))
- **Риск:** чтение отчётов расходует квоту, а submissions/reanalysis выполняют сетевые действия; стандартная отправка не конфиденциальна и может передавать содержимое сообществу и партнёрам. Не отправляйте документы, внутренний код, секреты или полные URL автоматически; сами submission tools не добавляют отдельного per-call consent. ([Official guidance](https://github.com/VirusTotal/virustotal-mcp), [Client permissions](https://github.com/VirusTotal/virustotal-mcp/blob/main/docs/clients.md))

Текущий README фиксирует следующую ручную установку; она не выполняется каталогом. Для token file ограничьте права чтения своим пользователем и передайте только путь, не содержимое. ([Installation and access](https://github.com/VirusTotal/virustotal-mcp))

```sh
uv tool install --python 3.12 --default-index https://pypi.org/simple 'vt-mcp==0.9.9'
```

JSON соответствует документированной stdio-конфигурации, но путь заменён на абсолютный placeholder, чтобы не зависеть от расширения `~` клиентом. Начните с разрешённых read-only report lookups и отдельного согласования любой отправки. ([Official stdio example](https://github.com/VirusTotal/virustotal-mcp), [Permissions guide](https://github.com/VirusTotal/virustotal-mcp/blob/main/docs/clients.md))

```json
{
  "mcpServers": {
    "virustotal": {
      "command": "vt-mcp",
      "args": [],
      "env": {
        "VTAI_TOKEN_FILE": "/absolute/path/to/protected/vtai-token"
      }
    }
  }
}
```

## Ручное подключение в Parrot после подготовки

- **Проверка проекта:** откройте отдельный разрешённый каталог, вручную проверьте существующие MCP-конфигурации и убедитесь, что нужный CLI уже установлен. Не подтверждайте доверие к скачанному проекту только ради обхода предупреждения.
- **Добавление Semgrep:** `pcode mcp add semgrep -- semgrep mcp` сохраняет конфигурацию сервера для текущего проекта, но сам по себе не устанавливает Semgrep и не вызывает сканирование. Имя `semgrep` здесь локальное имя подключения, а не catalog ID `semgrep-security`.
- **Discovery:** `pcode --trust-project mcp get semgrep` явно доверяет проекту, запускает настроенный сервер и получает список его инструментов. Команда не вызывает инструмент сканирования, но запуск стороннего MCP всё равно исполняет его код и может иметь собственные побочные эффекты.

```sh
# Выполнить вручную только после установки и проверки Semgrep CLI.
pcode mcp add semgrep -- semgrep mcp
# Запускает сервер и discovery, не security scan.
pcode --trust-project mcp get semgrep
```

Для остальных интеграций сначала завершите native setup, авторизацию или подготовку token file из соответствующего раздела, затем вручную добавьте выбранный JSON в MCP-конфигурацию и проверьте только нужный сервер через `pcode --trust-project mcp get <имя>`. Для диагностики сначала проверьте PATH, версии, абсолютные пути, состояние расширения и локальный listener; не пытайтесь исправить ошибку выдачей root-прав, отключением TLS или запуском активного теста.

## Проверка перед использованием

- **Supply chain:** изучите код и зависимости, зафиксируйте проверенную версию или commit вместо плавающего `latest`/Git HEAD, где это возможно. Не запускайте команды из описания инструмента или результата анализа как доверенные инструкции.
- **Минимальные права:** используйте отдельного непривилегированного пользователя/окружение, ограниченный проект и локальные listeners. Не переносите секреты проекта в контекст AI без необходимости.
- **Проверка соединения:** после ручной настройки проверьте discovery и описание инструментов, затем ограничьтесь безопасным чтением версии/статуса или уже существующих отчётов. Успешный discovery не подтверждает качество анализа, безопасность сервера или разрешение на активные действия.
- **Границы проверки:** в рамках этой подборки не выполнялись установки, авторизация сервисов, MCP handshakes, активные сканы или испытания Parrot VM. Ссылки и конфигурация проверены по документации, а не путём запуска инструментов.
