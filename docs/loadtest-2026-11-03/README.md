# Teste de carga do gateway OCPP: 03 e 04/11/2026 (card 69c5b5e7)

Rodada 4 (04/11, 00:26 a 01:49 UTC): frota 100% OCPP 2.0.1 e gerador corrigido depois da 2.ª revisão cruzada. Substitui os números das rodadas anteriores, que ficam no histórico do git (a59d6c6, 44f2271).

## Resposta curta

- **Hoje (configuração do LAB e do PROD): 1 cópia do gateway cai já com 100 carregadores.**
  - Com 100, o processo caiu na entrada e derrubou as 100 conexões juntas; 50 Boots passaram do tempo e as 100 só registraram em 90 s (corrigido: 20 s, sem queda).
  - Com 500, cai e volta várias vezes: 1800 quedas e 411 s até todas registrarem.
  - Com 1000, cai também em regime: 5065 quedas, chamadas com p95 de 2,8 s e, num momento, só 1 estação registrada.
  - Com 2000, não sustenta: em 10 min só 267 registradas e nenhum RemoteStart teve efeito.
  - Causa: pool do Postgres do gateway no padrão (5) e uma rejeição sem tratamento que derruba o processo.
- **Com as correções** (pool 20, correção da queda e limite de 20 conexões novas por segundo, rajada 50), 1 cópia sustenta **1000 carregadores com folga**, que é a meta:
  - todas registradas em 70 s, zero quedas, nenhuma transação recusada;
  - chamadas em regime com p50 de 16,5 ms e p95 de 47 ms;
  - RemoteStart com efeito em 182 a 228 ms e RemoteStop em 174 a 193 ms (5 de 5 cada);
  - reconexão de todas em 83 s depois de um restart.
- **2000 com as correções:** registra todas em 170 s, sem queda, e reconecta em 135 s. Mas a entrada fica no limite do tempo do Boot (p95 27,6 s, 499 Boots repetidos), o RabbitMQ chega a 145% de um núcleo e o RemoteStop sobe até 1,5 s. Fica como resultado medido, não como capacidade recomendada.

## Onde rodou e por quê

- **Fora do LAB.** O nó do LAB (`lab-power-manager-01`) tem hoje **1,9 GB de RAM** (`docker info`: MemTotal 1939 MB, 4 CPUs) e usa **82%** parado, com 600 MB em swap. O card manda parar acima de 80%, então no LAB o teste mediria swap e não o gateway. Decisão do João em 03/11: rodar uma cópia do stack do LAB nesta máquina e repetir no LAB quando a RAM dele voltar (card 4eb7d269).
- **Mesmas imagens e variáveis do LAB**, exportadas do Portainer do LAB:
  - gateway `citrineos:release-2026-10-30-tabelab`;
  - backend `csms-backend:release-2026-11-03-escala-lab`;
  - `postgis/postgis:16-3.5-alpine` e `rabbitmq:3-management-alpine`.
  - Biller e rate limit do backend desligados.
  - No Postgres, `pg_stat_statements` ligado para medir o tempo de query.
- **Tamanho do PROD**, lido no Portainer do PROD (só leitura): `power-manager-01` tem 4 CPUs e 8,2 GB.
  - Stack limitado a **4 núcleos** (`cpuset 0-3` em todos os serviços).
  - Memória: gateway 3 GB, Postgres 2 GB, RabbitMQ 1 GB, backend 1,5 GB, total 7,5 GB.
- **Separação de CPU:** o gerador rodou preso aos núcleos 8 a 15 (`taskset -c 8-15`); a máquina tem 16 núcleos.

## Carga gerada (`ocpp-simulator/bench/loadgen.js`)

- **Frota 100% OCPP 2.0.1** (porta 8081, profile 1 com Basic Auth), por decisão do João em 03/11: os carregadores do Power serão todos 2.0.1 ou superior. O gerador continua aceitando 1.6 (`--mix16`), sem uso nesta rodada. Serial `7300881xxxxxxxxx`, modelo "AC Wallbox 22", Everest.
- **Por estação:**
  - BootNotification e StatusNotification;
  - Heartbeat a cada 60 s e MeterValues a cada 60 s;
  - **20% começam em transação**: TransactionEvent Started e Updated a cada 60 s.
  - Os cartões existem no CitrineOS como Accepted e no CSMS como RFID ativo de um motorista do tenant Spotside Power, então o backend aceita as sessões (sem isso ele as recusa e manda RemoteStop).
- **Comandos executados de verdade, como um carregador:**
  - 2.0.1 RequestStartTransaction: Accepted e TransactionEvent Started, com remoteStartId e idToken.
  - RequestStopTransaction: Ended se o transactionId for o corrente, senão Rejected.
- **Boot não aceito** (sem resposta, Pending ou Rejected): repetido depois do intervalo pedido pelo CSMS ou 30 s, como um firmware.
- **Queda:** a estação volta com espera exponencial aleatória (1 a 30 s) e respeita o `Retry-After`.
- **Sequência por patamar** (`scripts/local-loadtest-tier.sh`):
  1. Entrada a 50 conexões/s, até todas registrarem (máximo 10 min).
  2. 2 min em regime.
  3. 5 RemoteStart em estações livres, pela API do CitrineOS. Depois, RemoteStop das que iniciaram.
  4. Restart do gateway e tempo até todas reconectarem (máximo 10 min).
  5. 1 min de folga.
- **Coleta a cada 15 s** (`scripts/local-loadtest-metrics.sh`):
  - `docker stats`;
  - conexões, consultas/s e tempo médio por consulta no Postgres (`pg_stat_statements`, diferenças por janela);
  - mensagens publicadas e entregues por segundo e mensagens em fila no RabbitMQ (API de gestão).



## Resultados

"Regime" é a média das amostras de 30 s entre o fim da entrada e o restart. CPU em % de um núcleo. "Registrada" é uma estação distinta, conectada agora e com Boot aceito; quem cai deixa de contar até registrar de novo.

### A. Como está hoje: gateway do LAB, pool padrão (5), sem proteção

| | 100 | 500 | 1000 | 2000 |
|---|---|---|---|---|
| Todas registradas ao fim da entrada | 100 em 90 s | 500 em 411 s | 1000 em 461 s | **267 de 2000** em 10 min |
| Boot p95, Boots fora do tempo (30 s) | 3,2 s, 50 | 13,6 s, 683 | 27,6 s, 2919 | 28,4 s, 28646 |
| Quedas de conexão antes do restart | **100** | **1800** | **5065** | **10100** |
| Mínimo de registradas durante o regime | 100 | 500 | **1** | **0** |
| Chamadas em regime (p50 / p95) | 14 / 28,5 ms | 13 / 29,5 ms | 20 / **2771** ms | 41 / **5044** ms |
| RemoteStart: chegada / efeito | 144-153 / 167-177 ms (5 de 5) | 131-162 / 154-188 ms (5 de 5) | 143-187 / 182-232 ms (5 de 5) | 303-7318 ms / **nenhum efeito (0 de 5)** |
| RemoteStop: chegada / efeito | 129-142 / 147-169 ms (5 de 5) | 133-154 / 161-185 ms (5 de 5) | 139-163 / 177-200 ms (5 de 5) | 171-275 ms / **0 de 5** |
| Transações em andamento em regime; recusadas ou sem resposta | 19; 5 | 57; 40 | 151; 61 | 175; 165 |
| Reconexão de todas após restart | 7 s | 21 s | 84 s | 478 s |
| Gateway CPU regime / pico, RAM | 4% / 102%, 214 MB | 16% / 128%, 432 MB | 60% / 137%, 466 MB | 50% / 154%, 510 MB |
| Backend CPU regime, RAM | 1%, 115 MB | 1%, 112 MB | 4%, 159 MB | 9%, 120 MB |
| Postgres CPU regime, RAM | 3%, 144 MB | 6%, 144 MB | 26%, 152 MB | 18%, 194 MB |
| Postgres: consultas/s, ms por consulta (pico), conexões | 145, 0,059 (0,199), 24 | 318, 0,044 (0,198), 23 | 1188, 0,033 (0,162), 21 | 979, 0,050 (0,416), 25 |
| RabbitMQ CPU regime, RAM | 2%, 165 MB | 14%, 192 MB | 31%, 292 MB | 81%, 406 MB |
| RabbitMQ: publicadas / entregues por s, maior fila | 8,4 / 8,4, 154 | 33,6 / 34,5, 615 | 58,7 / 59,0, 1667 | 78,3 / 75,7, **3644** |
| Memória do stack (pico) | 819 MB | 875 MB | 998 MB | 1,4 GB |

**Causa:**
- O pool do Postgres do gateway é o padrão de 5. Nem o LAB nem o PROD definem `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX`; conferi o PROD só por leitura.
- Numa rajada, o `SequelizeConnectionAcquireTimeoutError` sai de `WebhookDispatcher.dispatchMessageReceived`, chamado em `MessageRouterImpl.onMessage`.
- O handler do WebSocket não aguarda essa chamada, então a rejeição fica sem tratamento e **o processo sai** (log: `ConnectionAcquireTimeoutError ... Node.js v24.4.1` seguido de `Executing DB strategy: migrate`).
- O Postgres não é o gargalo: até 25 conexões e menos de 0,5 ms por consulta. O limite é o pool de 5 do lado do gateway.

### B. Corrigido: pool 20 + correção da queda + proteção a 20/s (rajada 50)

Imagem do gateway montada sobre a main do gateway (`9e95199`) com `fix/gateway-ws-protection` (até `445b8a8`) e `fix/gateway-crash-on-pool-timeout`. Com `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20`.

| | 100 | 500 | 1000 | 2000 |
|---|---|---|---|---|
| Todas registradas ao fim da entrada | 100 em 20 s | 500 em 30 s | **1000 em 70 s** | 2000 em 170 s |
| Boot p95, Boots fora do tempo (30 s) | 2,3 s, 1 | 2,5 s, 0 | 6,4 s, 0 | 27,6 s, 499 |
| Quedas de conexão antes do restart | **0** | **0** | **0** | **0** |
| Mínimo de registradas durante o regime | 100 | 500 | 1000 | 2000 |
| Recusas 503 (proteção espaçando a entrada) | 24 | 986 | 3629 | 11383 |
| Chamadas em regime (p50 / p95) | 14 / 32 ms | 16 / 40 ms | 16,5 / 47 ms | 39 / 79 ms |
| RemoteStart: chegada / efeito | 129-149 / 151-192 ms (5 de 5) | 129-139 / 158-166 ms (5 de 5) | 151-184 / 182-228 ms (5 de 5) | 173-245 / 225-377 ms (5 de 5) |
| RemoteStop: chegada / efeito | 118-139 / 146-158 ms (5 de 5) | 135-151 / 155-183 ms (5 de 5) | 144-161 / 174-193 ms (5 de 5) | 251-408 / 361-1524 ms (5 de 5) |
| Transações em andamento em regime; recusadas ou sem resposta | 20; 0 | 92; 0 | 190; 0 | 410; 9 |
| Reconexão de todas após restart | 73 s | 45 s | 83 s | 135 s |
| Gateway CPU regime / pico, RAM | 6% / 122%, 195 MB | 18% / 135%, 382 MB | 28% / 122%, 400 MB | 49% / 127%, 409 MB |
| Backend CPU regime, RAM | 7%, 114 MB | 3%, 115 MB | 10%, 113 MB | 6%, 116 MB |
| Postgres CPU regime, RAM | 6%, 196 MB | 13%, 225 MB | 20%, 230 MB | 33%, 251 MB |
| Postgres: consultas/s, ms por consulta (pico), conexões | 130, 0,102 (0,278), 31 | 346, 0,112 (0,178), 30 | 624, 0,102 (0,116), 37 | 1131, 0,152 (0,211), 38 |
| RabbitMQ CPU regime, RAM | 2%, 251 MB | 14%, 226 MB | 35%, 256 MB | **145%**, 438 MB |
| RabbitMQ: publicadas / entregues por s, maior fila | 7,7 / 6,5, 1 | 37,3 / 37,5, 4 | 76,3 / 76,0, 2 | 150,2 / 150,1, 89 |
| Memória do stack (pico) | 935 MB | 1,1 GB | 1,1 GB | 1,2 GB |

- Nos quatro patamares não houve nenhuma queda do processo.
- A consulta mais lenta do Postgres ficou entre 8 e 9 ms de média; é sempre a mesma, de manutenção.
- A reconexão de 73 s em 100 é o `Retry-After` de 5 s mais a espera aleatória das estações recusadas no início do restart; não houve queda.
- Em 2000, as 9 transações sem resposta e o RemoteStop de até 1,5 s acompanham o RabbitMQ acima de um núcleo inteiro: é o primeiro serviço a saturar.

## Conclusão

**Limite prático de 1 cópia:**
- **Hoje:** abaixo de 100. Com 100 o gateway já cai, e isso vale para o PROD, que tem a mesma configuração.
- **Com as correções:** 1000 com folga, que é a meta (decisão do João em 03/11). 2000 registra e fica de pé, mas sem margem: Boot no limite do tempo e RabbitMQ saturado.

**O que entra antes de ter carregadores no PROD:**
1. `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20` no stack.
2. A correção da queda (card 26140c80, `fix/gateway-crash-on-pool-timeout`).
3. A proteção do WebSocket (65a03b5e), com o padrão de 20/s e rajada 50 medido aqui.

**Limites por serviço (fe3f07b8), com os números de 1000:**
- gateway: reserva de 1 núcleo e 512 MB, limite de 1 GB;
- RabbitMQ: reserva de 0,5 núcleo, limite de 1 GB (em 2000 ele precisa de 1,5 núcleo);
- Postgres: reserva de 0,5 núcleo, limite de 1 GB;
- backend: 512 MB;
- `nofile` 65536 no gateway.

**Redis, HAProxy e várias cópias (etapas 4 a 6):** não são necessários para 1000. O backend ficou abaixo de 10% de um núcleo e 160 MB, e o Postgres com até 38 conexões e 0,15 ms por consulta. Ficam para quando a frota se aproximar de 2000, quando o RabbitMQ também precisa de mais CPU.

## Achados das revisões cruzadas e o que foi feito

**1.ª revisão (03/11):**
1. Quatro patamares da cópia atual e 2000 extrapolado: medidos nas duas configurações (tabelas A e B).
2. Relatório fora do commit e métricas faltando: tempo por consulta e consultas/s do Postgres (`pg_stat_statements`), publicadas e entregues por segundo e maior fila do RabbitMQ nas tabelas; relatório, roteiros e dados brutos commitados aqui.
3. OCPP 1.6: o gerador cobre 1.6 e frota mista (`--mix16`). Esta rodada é 100% 2.0.1 por decisão do João em 03/11 23:35.
4. RemoteStart/Stop sem efeito: o gerador inicia e para a transação de verdade.

**2.ª revisão (03/11):**
1. Execução fora do LAB: aceita pelo João em 03/11 20:31 para este card; a repetição no LAB (100 e 1000) fica no card 4eb7d269.
2. 2000 não demonstrado: o gerador repete o Boot não aceito, e o 2000 foi medido por inteiro nas duas configurações.
3. Efeito de transação contado como sucesso: só conta com resposta aceita; recusa ou falta de resposta encerra a transação e grava `start-failed`/`stop-failed`.
4. Fim da entrada por contador cumulativo: o gerador conta estações distintas registradas agora (`registered`), e o roteiro espera `registered >= N`.

**3.ª revisão (03/11, arbitragem do João):**
1. **2000 fora das tabelas.** Corrigido: o 2000 voltou às tabelas A e B com todas as métricas, como resultado medido. O contrato do card registra a meta de 1000 (João, 03/11 20:29).
2. **Nenhum RemoteStop em 1.6.** Não se aplica mais: a frota é 100% 2.0.1 por decisão do João (03/11 23:35). O roteiro, mesmo assim, garante um RemoteStop em 1.6 por patamar quando houver estações 1.6, e o resumo marca a cobertura por tipo de comando (`command_coverage`).
3. **TypeError quando um Stop chega com o Start pendente.** Corrigido em `bench/loadgen.js`: a transação fica numa referência local e, se for parada antes da resposta, o gerador registra `stopped-while-starting` como falha. Nenhum `generator:unhandledRejection` nos 8 patamares desta rodada.

## Arquivos e comandos

- Gerador: `ocpp-simulator/bench/loadgen.js`.
  - `LT_PW=... taskset -c 8-15 node bench/loadgen.js --url ws://127.0.0.1:18081 --url16 ws://127.0.0.1:18092 --mix16 0 --count N --ramp 50 --tx 0.2`
- Bateria completa: `scripts/local-loadtest-all.sh`, que chama `scripts/local-loadtest-tier.sh <rótulo> <N> 50 0.2 0`.
- Resumo de um patamar: `scripts/loadtest-summary.py <pasta>`.
- Dados brutos por patamar em `data/{asis,fixed}-{100,500,1000,2000}/`: `loadgen.jsonl`, `metrics.jsonl`, `events.jsonl` e `summary.json`.
- A primeira rodada ficou em `data/rodada1-somente-201/`; as rodadas 2 e 3 (frota mista) estão nos commits a59d6c6 e 44f2271.
- Stack local: `~/.config/spotside/lt-stack/docker-compose.json`. Tem senhas do LAB, está com chmod 600 e fora dos repositórios. Seeds no mesmo diretório: `seed-local.sql` (citrine: estações, senhas e autorizações) e `seed-csms-local.sql` (csms_db: motorista e cartões RFID). Com o banco recriado, o tenant padrão do backend (`CITRINEOS_DEFAULT_TENANT_ID`) precisa apontar para um tenant existente, senão toda sessão é recusada como de outro operador.

## Observações

- **"Tariff not found" no log do gateway:** as estações de teste não têm tarifa. Não afeta o envio.
- **Transações recusadas na configuração atual:** são as que ficam sem resposta quando o gateway cai (`tx201:no-response`); na corrigida, só 9 em 2000.
- **Auto-registro:** o backend criou um carregador `pending` por estação no banco local, como faria com um carregador real.

## Limpeza

LAB, depois do teste com uma estação (`scripts/loadtest-cleanup-citrine.sql` e `scripts/loadtest-cleanup-csms.sql`):

```
citrine:  select count(*) from "ChargingStations" where id like '7300881%';           -> 0
          select count(*) from "VariableAttributes" where "stationId" like '7300881%';  -> 0
csms_db:  select count(*) from chargers where "citrineChargePointId" like '7300881%';  -> 0
```

O stack local continua de pé até o card fechar (a limpeza de 03/11 com `down -v` apagou os seeds e invalidou a primeira tentativa da rodada 4). Ao fechar: `docker compose -f ~/.config/spotside/lt-stack/docker-compose.json down -v`.
