# AirGuard Web: contatos úteis

Aplicativo web para celular onde cada usuário guarda os **contatos úteis da cozinha/casa**
(farmácia, médico, gás, água, mercado, delivery, marido de aluguel, eletricista, encanador,
chaveiro, assistência de eletrodomésticos e outros), cada um com o **ícone do serviço**. O **notebook hospeda** a página e a API na rede local, e o
**ESP32 lê pelo Wi-Fi** a lista de todos os números.

- `server/`: Node 20 + Express. API, controle de acesso e dados em `data/db.json`.
- `web/`: React + Vite + TypeScript. Interface de celular com visual futurista, instalável na tela
  inicial (PWA).

Endereço na rede local: **http://192.168.1.10:8787**. O IP do notebook foi fixado na rede Wi-Fi
`MinhaRede`.

## Acesso: um código por usuário

- Cada usuário recebe um **link pessoal** no formato `http://192.168.1.10:8787/#k=<código>`.
- O código tem **256 bits aleatórios** (32 bytes do gerador criptográfico do sistema, 43
  caracteres). Não dá para adivinhar nem testar por força bruta.
- O servidor guarda **só o hash SHA-256** do código. Uma cópia de `data/db.json` não revela nenhum
  código válido. O link é mostrado **uma única vez**, quando o usuário é criado.
- O código fica **depois do `#`**: o navegador não o envia na linha da requisição, então ele não
  aparece em logs nem no cabeçalho Referer. O app o guarda no aparelho (para abrir pelo ícone da
  tela inicial) e o tira da barra de endereço.
- Tentativas erradas são limitadas a 10 por minuto por IP (resposta 429).
- **Cada usuário vê e altera só os próprios contatos.**

## Senha de edição

- Cadastrar, **editar** e excluir contatos pede a **senha de edição** do usuário. Ver a lista,
  ligar e abrir o WhatsApp não pedem senha.
- Na primeira vez que o usuário tenta cadastrar, editar ou excluir, o app pede que ele **crie** a
  senha (de 4 a 64 caracteres). Depois disso, ela é pedida uma vez a cada vez que a página é aberta e
  fica **só na memória** do navegador, nunca em `localStorage`.
- Para trocar a senha, toque no seu nome no canto superior direito. A troca exige a senha atual.
- O servidor guarda só o **hash scrypt** da senha, com salt aleatório. Senhas erradas contam no
  mesmo limite de 10 tentativas por minuto por IP.
- Senha esquecida: `user:password-reset <id>` apaga a senha, e o usuário cria uma nova no app.
- Para editar um contato, toque no nome ou no telefone dele.

## Painel Ambiente (telemetria em tempo real)

A aba **Ambiente** (`/ambiente`, com o mesmo link pessoal) mostra:

- o **estado geral** em linguagem simples ("Ambiente seguro", "Atenção: gás acima do normal",
  "Perigo: gás detectado") e as leituras atuais de temperatura, umidade e gás (com a escala dos
  limites de 0,90 V e 1,50 V);
- o **histórico** de 1 h, 6 h, 24 h, 7 dias ou 30 dias: um gráfico por grandeza, com média,
  mínimo e máximo de cada intervalo, faixa de conforto, linhas dos limites do gás e marcas dos
  alertas. Cada gráfico tem uma tabela com os mesmos dados;
- a **comunicação LoRa** entre o ESP32 (KITCHEN_01) e o RP2040 (GATEWAY_01): placas online, RSSI,
  SNR, perda de pacotes, tempo até a confirmação (ACK) e a lista de pacotes ao vivo. Cada pacote
  mostra o sentido, o tipo, o estado (recebido, confirmado, perdido, retransmitido) e, ao tocar,
  o quadro JSON enviado pelo rádio;
- as **ocorrências** (alertas e normalizações).

**De onde vêm os dados:** o **ESP32** é a única placa na rede. Ele registra tudo o que envia e
recebe pelo LoRa e publica pelo **Wi-Fi** no broker **MQTT** deste notebook (`mosquitto`,
porta 1883), no tópico `airguard/KITCHEN_01/telemetry`, a cada 2 s, sem notebook nem USB. O
servidor assina `airguard/+/telemetry` (`server/src/mqtt_ingest.js`) com o login `airguard`. O **RP2040** não grava nada: ele informa o ESP32 pelo próprio LoRa, com o
RSSI/SNR dentro de cada ACK e um quadro **STAT** a cada 15 s (quais heartbeats ouviu, contadores,
LCD). Formato dos registros: `AirGuard-IoT/docs/11_telemetry.md`. O histórico fica em
`data/telemetry/` (um arquivo por dia, guardado por 30 dias).

```bash
# 1) login MQTT: o usuário "airguard" é criado pelo broker a partir de AIRGUARD_MQTT_USERNAME /
#    AIRGUARD_MQTT_PASSWORD no .env do Mosquitto (mosquitto). O servidor lê o mesmo login
#    de MQTT_USERNAME / MQTT_PASSWORD no .env deste projeto (modelo: .env.example).
# 2) no ESP32: preencha AirGuard-IoT/src/config/net_secrets.h antes de gravar, ou no console USB
#      net ssid <rede>   net pass <senha>   net broker 192.168.1.10:1883   net user airguard   net mqttpass <senha>
# 3) sem placas, dados sintéticos no mesmo formato (pela rota HTTP, que continua aceitando o lote):
docker compose exec airguard-web node server/src/cli.js device:add "Simulador"
python3 tools/simulate_node.py --key <chave> --server http://127.0.0.1:8787
```

Variáveis do servidor: `MQTT_URL` (no Docker, `mqtt://host.docker.internal:1883`; vazio desliga o
MQTT), `MQTT_USERNAME`, `MQTT_PASSWORD`. O estado da conexão aparece em `/api/telemetry/state`
(campo `mqtt`).

- Se o Wi-Fi ou o servidor cair, o ESP32 guarda os registros na RAM (cerca de 2 a 3 minutos) e
  envia depois, com o horário certo. O alarme local não depende da rede.
- O servidor dá a cada registro o horário de chegada menos a idade informada pelo ESP32
  (`now - ms`): a placa não precisa de relógio.

## Administração

Os comandos estão na seção do Docker abaixo. Sem Docker, use `cd server && npm run user:add -- "Maria"`
(e também `user:list`, `user:revoke`, `device:add`). O link aparece **uma única vez**, e o servidor
em execução percebe as mudanças sozinho, sem reiniciar.

## Rodar com Docker (inicia sozinho com o notebook)

O container usa `restart: unless-stopped`, e o serviço do Docker já inicia com o sistema. Assim,
depois de um reboot o AirGuard Web **volta sozinho**, sem precisar de login.

```bash
cd AirGuard-Web
docker compose up -d --build        # compila o app e inicia (repita após mudar o código)
docker compose logs -f              # log do servidor
docker compose stop                 # para (não volta no reboot até um "start"/"up")
```

Os dados ficam em `./data/db.json` (volume), fora da imagem: recriar o container não apaga nada.

Administração, com o container rodando:

```bash
docker compose exec airguard-web node server/src/cli.js user:add "Maria"
docker compose exec airguard-web node server/src/cli.js user:list
docker compose exec airguard-web node server/src/cli.js user:revoke <id>
docker compose exec airguard-web node server/src/cli.js user:password-reset <id>
docker compose exec airguard-web node server/src/cli.js device:add "ESP32"
```

### Sem Docker (desenvolvimento)

```bash
export PATH="$HOME/.nvm/versions/node/v20.17.0/bin:$PATH"
(cd web && npm install && npm run build)     # gera web/dist
(cd server && npm install && npm start)      # http://0.0.0.0:8787
```

Testes do servidor (21, com `node:test`): `cd server && npm test`.
Interface com recarga automática: `cd web && npm run dev` (porta 5174, com proxy para a API em 8787).
Não rode o modo sem Docker e o container ao mesmo tempo: os dois usam a porta 8787.

## API

| Método | Rota | Autenticação | Resposta |
|---|---|---|---|
| GET | `/api/me` | `Authorization: Bearer <código>` | `{ name, hasPassword }` |
| POST | `/api/password` `{password, current?}` | idem | 204 / 400 `invalid_password` / 403 `wrong_password` (troca sem a senha atual correta) |
| POST | `/api/password/check` | idem + `X-Edit-Password` | 204 / 403 `wrong_password` / 428 `password_not_set` |
| GET | `/api/contacts` | código | contatos **do usuário** (com `category`) |
| POST | `/api/contacts` `{name, phone, category?}` | código + `X-Edit-Password` | 201 / 400 `invalid_name`, `invalid_phone`, `invalid_category` / 409 `duplicate_phone`, `limit_reached` / 403 / 428 |
| PUT | `/api/contacts/:id` `{name, phone, category?}` | código + `X-Edit-Password` | 200 / 400 / 404 / 409 `duplicate_phone` / 403 / 428 |
| DELETE | `/api/contacts/:id` | código + `X-Edit-Password` | 204 / 404 / 403 / 428 |
| GET | `/api/device/contacts` | `X-Device-Key: <chave>` | `{ contacts: [{ name, phone, category }] }`: números de **todos** os usuários, sem repetição |
| GET | `/api/telemetry/state` | código | leituras atuais, placas online, enlace LoRa, últimos 120 pacotes e alertas |
| GET | `/api/telemetry/history?range=1h\|6h\|24h\|7d\|30d` | código | séries agregadas (média, mín, máx) + alertas do período |
| GET | `/api/telemetry/stream` | código | `text/event-stream`: `status` (a cada 3 s), `env`, `packet`, `alert`, `gw`, `boot` |
| POST | `/api/telemetry/ingest` `{now, records:[...]}` | `X-Device-Key` | `{ kept }` (simulador; o ESP32 usa MQTT. Lote de até 5000 registros) |

- Categorias (`category`): `farmacia`, `medico`, `gas`, `agua`, `mercado`, `delivery`, `marido`,
  `eletricista`, `encanador`, `chaveiro`, `eletro`, `outro`. Sem categoria vira `outro` (contatos
  antigos também). A lista está em `server/src/categories.js` e, com rótulos e ícones, em
  `web/src/categories.tsx`: as duas precisam ter os mesmos ids.
- Telefones são guardados em **E.164** (`+5511988887777`), o formato do WhatsApp.
- Números brasileiros são aceitos em qualquer forma comum: `(11) 98888-7777`, `11988887777`,
  `+55 11 98888 7777`, `011 98888-7777`. Números de outros países precisam começar com `+`.
- Limites: nome com 1–40 caracteres, 100 contatos por usuário, corpo da requisição até 4 KB.

## Limitações

- **HTTP sem TLS:** na rede local, o código trafega sem criptografia de aplicação. A proteção vem
  da senha WPA2 do Wi-Fi. Quem estiver na mesma rede e capturar o tráfego pode ver um código.
  Para acesso fora de casa, coloque o servidor atrás de HTTPS (proxy reverso ou túnel) antes de
  expor a porta.
- O código fica salvo no celular (localStorage). Quem tiver o aparelho desbloqueado consegue abrir
  o app. Para cortar o acesso, use `user:revoke`.
- Dados num arquivo JSON: suficiente para dezenas de usuários. Para mais do que isso, trocar por
  SQLite.
