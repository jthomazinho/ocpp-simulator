# Teste de carga do gateway OCPP: 03/11/2026 (card 69c5b5e7)

Rodada 3, com o gerador corrigido depois da 2.ª revisão cruzada. Substitui os números das rodadas anteriores.

## Resposta curta

- **Hoje (configuração do LAB e do PROD): 1 cópia do gateway cai já com 100 carregadores.**
  - Com 100, o processo caiu uma vez durante o regime e derrubou as 100 conexões juntas (100 quedas antes do restart, mínimo de 0 estações registradas no regime).
  - Com 500, o gateway cai e volta várias vezes: 1650 quedas, 567 Boots fora do tempo, 260 s para todas registrarem.
  - Com 1000, todas só registram depois de 472 s, à custa de 4583 Boots repetidos, e as quedas continuam (3000).
  - Causa: pool do Postgres do gateway no padrão (5) e uma rejeição sem tratamento que derruba o processo.
- **Com as correções** (pool 20, correção da queda e limite de 20 conexões novas por segundo, rajada 50), 1 cópia sustenta **1000 carregadores com folga**:
  - todas registradas em 70 s, zero quedas;
  - chamadas em regime com p50 de 14,5 ms e p95 de 46 ms;
  - RemoteStart e RemoteStop com efeito na transação em 191 a 291 ms (13 de 13);
  - reconexão de todas em 86 s depois de um restart.
- **Meta:** 1000 carregadores (decisão do João em 03/11). 2000 fica só como observação, no fim.

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

- **Frota mista:** 70% OCPP 2.0.1 (porta 8081) e 30% OCPP 1.6 (porta 8092), ambas em profile 1 com Basic Auth, como a frota real. Serial `7300881xxxxxxxxx`, modelo "AC Wallbox 22", Everest.
- **Por estação:**
  - BootNotification e StatusNotification;
  - Heartbeat a cada 60 s e MeterValues a cada 60 s;
  - **20% começam em transação**: 2.0.1 com TransactionEvent Started e Updated a cada 60 s; 1.6 com StartTransaction e MeterValues com transactionId.
  - Os idTags existem no CitrineOS como Accepted.
- **Comandos executados de verdade, como um carregador:**
  - 2.0.1 RequestStartTransaction: Accepted e TransactionEvent Started, com remoteStartId e idToken.
  - RequestStopTransaction: Ended se o transactionId for o corrente, senão Rejected.
  - 1.6 RemoteStartTransaction: Accepted e StartTransaction.
  - RemoteStopTransaction: StopTransaction do transactionId corrente, senão Rejected.
- **Boot não aceito** (sem resposta, Pending ou Rejected): repetido depois do intervalo pedido pelo CSMS ou 30 s, como um firmware.
- **Queda:** a estação volta com espera exponencial aleatória (1 a 30 s) e respeita o `Retry-After`.
- **Sequência por patamar** (`scripts/local-loadtest-tier.sh`):
  1. Entrada a 50 conexões/s, até todas registrarem (máximo 10 min).
  2. 2 min em regime.
  3. 5 RemoteStart em 2.0.1 e 5 em 1.6, em estações livres, pela API do CitrineOS. Depois, RemoteStop das que iniciaram.
  4. Restart do gateway e tempo até todas reconectarem (máximo 10 min).
  5. 1 min de folga.
- **Coleta a cada 15 s** (`scripts/local-loadtest-metrics.sh`):
  - `docker stats`;
  - conexões, consultas/s e tempo médio por consulta no Postgres (`pg_stat_statements`, diferenças por janela);
  - mensagens publicadas e entregues por segundo e mensagens em fila no RabbitMQ (API de gestão).


## Resultados

"Regime" é a média das amostras de 30 s entre o fim da entrada e o restart. CPU em % de um núcleo. "Registrada" é uma estação distinta, conectada agora e com Boot aceito; quem cai deixa de contar até registrar de novo.

### A. Como está hoje: gateway do LAB, pool padrão (5), sem proteção

| | 100 | 500 | 1000 |
|---|---|---|---|
| Todas registradas ao fim da entrada | 100 em 20 s | 500 em 260 s | 1000 em **472 s** |
| Boot p95, Boots fora do tempo (30 s) | 4,9 s, 0 | 18,0 s, **567** | 28,2 s, **4583** |
| Quedas de conexão antes do restart | **100** (uma queda do processo) | **1650** | **3000** |
| Mínimo de registradas durante o regime | **0** | **17** | 1000 |
| Chamadas em regime (p50 / p95) | 7,5 / 20,5 ms | 11 / 37,5 ms | 14 / 44 ms |
| RemoteStart/Stop: chegada / efeito na transação | 158 a 238 / 175 a 272 ms (13 de 13) | 149 a 209 / 167 a 265 ms (13 de 13) | 311 a 1109 / 362 a 1752 ms (13 de 13) |
| Transações recusadas ou sem resposta | 8 | 54 | 65 |
| Reconexão de todas após restart | 13 s | 25 s | 97 s |
| Gateway CPU regime / pico, RAM | 3% / 97%, 412 MB | 25% / 141%, 430 MB | 34% / 154%, 483 MB |
| Postgres: consultas/s, ms por consulta (pico), conexões | 195, 0,103 (0,54), 20 | 583, 0,031 (0,54), 23 | 540, 0,065 (0,55), 24 |
| RabbitMQ: publicadas / entregues por s, maior fila | 15,6 / 16,5, 111 | 46,6 / 45,4, 705 | 70,5 / 69,1, **1204** |
| Memória do stack (pico) | 772 MB | 894 MB | 1,1 GB |

**Causa:**
- O pool do Postgres do gateway é o padrão de 5. Nem o LAB nem o PROD definem `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX`; conferi o PROD só por leitura.
- Numa rajada, o `SequelizeConnectionAcquireTimeoutError` sai de `WebhookDispatcher.dispatchMessageReceived`, chamado em `MessageRouterImpl.onMessage`.
- O handler do WebSocket não aguarda essa chamada, então a rejeição fica sem tratamento e **o processo sai** (log: `ConnectionAcquireTimeoutError ... Node.js v24.4.1` seguido de `Executing DB strategy: migrate`).
- Em 1000 o regime parece bom porque é medido depois que todas registraram, o que levou 8 minutos de quedas e Boots repetidos.

### B. Corrigido: pool 20 + correção da queda + proteção a 20/s (rajada 50)

Imagem do gateway montada sobre a main do gateway (`9e95199`) com `fix/gateway-ws-protection` e `fix/gateway-crash-on-pool-timeout`. Com `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20`.

| | 100 | 500 | 1000 |
|---|---|---|---|
| Todas registradas ao fim da entrada | 100 em 20 s | 500 em 30 s | **1000 em 70 s** |
| Boot p95, Boots fora do tempo (30 s) | 4,0 s, 0 | 2,7 s, 0 | 7,2 s, 0 |
| Quedas de conexão antes do restart | **0** | **0** | **0** |
| Mínimo de registradas durante o regime | 100 | 500 | 1000 |
| Recusas 503 (proteção espaçando a entrada) | 19 | 936 | 3437 |
| Chamadas em regime (p50 / p95) | 12 / 25,5 ms | 13 / 33 ms | 14,5 / 46 ms |
| RemoteStart/Stop: chegada / efeito na transação | 128 a 162 / 143 a 181 ms (13 de 13) | 131 a 154 / 147 a 172 ms (12 de 12) | 152 a 248 / 191 a 291 ms (13 de 13) |
| Transações recusadas ou sem resposta | 5 | 17 | 29 |
| Transações em andamento em regime | 11 | 100 | 180 |
| Reconexão de todas após restart | 9 s | 45 s | 86 s |
| Gateway CPU regime / pico, RAM | 5% / 113%, 200 MB | 19% / 119%, 373 MB | 29% / 109%, 401 MB |
| Backend CPU regime, RAM | 6%, 110 MB | 5%, 122 MB | 3%, 109 MB |
| Postgres CPU regime, RAM | 4%, 186 MB | 12%, 194 MB | 15%, 216 MB |
| Postgres: consultas/s, ms por consulta (pico), conexões | 146, 0,063 (0,159), 33 | 343, 0,075 (0,155), 41 | 584, 0,073 (0,116), 41 |
| RabbitMQ CPU regime, RAM | 2%, 257 MB | 16%, 255 MB | 36%, 283 MB |
| RabbitMQ: publicadas / entregues por s, maior fila | 8,3 / 7,6, 0 | 37,5 / 36,4, 4 | 68,9 / 74,6, 7 |
| Memória do stack (pico) | 901 MB | 1,0 GB | 1,1 GB |

- Nos três patamares não houve nenhuma queda do processo.
- A consulta mais lenta do Postgres ficou entre 16 e 18 ms de média; é sempre a mesma, de manutenção.
- "Transações recusadas" são quase todas `tx16:idTag:ConcurrentTx`: o gerador reaproveita idTags entre estações 1.6, e o CSMS recusa o mesmo idTag em duas transações. O gerador encerra a transação recusada, como um carregador faria, e não conta como efeito.

## Conclusão

**Limite prático de 1 cópia:**
- **Hoje:** abaixo de 100. Com 100 o gateway já cai, e isso vale para o PROD, que tem a mesma configuração.
- **Com as correções:** 1000 com folga, que é a meta.

**O que entra antes de ter carregadores no PROD:**
1. `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20` no stack.
2. A correção da queda (card 26140c80, `fix/gateway-crash-on-pool-timeout`).
3. A proteção do WebSocket (65a03b5e), com o padrão de 20/s e rajada 50 medido aqui.

**Limites por serviço (fe3f07b8), com os números de 1000:**
- gateway: reserva de 1 núcleo e 512 MB, limite de 1 GB;
- RabbitMQ: reserva de 0,5 núcleo, limite de 1 GB;
- Postgres: reserva de 0,5 núcleo, limite de 1 GB;
- backend: 512 MB;
- `nofile` 65536 no gateway.

**Redis, HAProxy e várias cópias (etapas 4 a 6):** não são necessários para 1000. O backend ficou abaixo de 6% de um núcleo e 122 MB, e o Postgres com até 41 conexões e 0,06 a 0,08 ms por consulta. Ficam para quando a frota se aproximar de 2000.

## Observação: 2000 (fora da meta)

Rodado na mesma bateria e registrado só como referência:
- **Hoje:** não sustenta. Ao fim de 10 min, 362 de 2000 registradas; depois do restart, 156; 32971 Boots fora do tempo e 6750 quedas.
- **Corrigido:** com o gerador agora repetindo o Boot como um carregador real, as 2000 registram em 170 s, sem queda (Boot p95 28,9 s, 509 Boots fora do tempo), e reconectam em 164 s. Em regime: p50 44,5 ms e p95 126 ms; RabbitMQ a 141% de um núcleo e Postgres a 1047 consultas/s.
- Não conclui capacidade para 2000: a entrada fica no limite do tempo do Boot e o RabbitMQ divide os 4 núcleos com o gateway e o Postgres. Dados em `data/asis-2000` e `data/fixed-2000`.

## Achados das revisões cruzadas e o que foi feito

**1.ª revisão (03/11):**
1. Quatro patamares da cópia atual e 2000 extrapolado: rodado nas duas configurações (tabelas A e B).
2. Relatório fora do commit e métricas faltando: tempo por consulta e consultas/s do Postgres (`pg_stat_statements`), publicadas e entregues por segundo e maior fila do RabbitMQ nas tabelas; relatório, roteiros e dados brutos commitados aqui.
3. OCPP 1.6: frota mista com 30% em 1.6, com RemoteStart e RemoteStop em 1.6.
4. RemoteStart/Stop sem efeito: o gerador inicia e para a transação de verdade.

**2.ª revisão (03/11):**
1. **Execução fora do LAB.** Decisão do João em 03/11: a medição local, com o tamanho do PROD, vale para este card; a repetição no LAB, nos patamares de 100 e 1000 com este gerador, fica no card 4eb7d269, à espera da RAM do LAB.
2. **2000 não demonstrado.** Procede. A conclusão sobre 2000 saiu; a meta passou a ser 1000 (decisão do João em 03/11), e 2000 ficou como observação. O gerador agora repete o Boot não aceito (`boot()` em `bench/loadgen.js`), como um firmware.
3. **Efeito de transação contado como sucesso.** Corrigido em `bench/loadgen.js`: em 1.6, `idTagInfo` diferente de Accepted ou sem resposta encerra a transação (StopTransaction `DeAuthorized`) e grava `start-failed`; em 2.0.1, sem resposta ou `idTokenInfo` recusado grava `start-failed` e envia `Ended`; o stop só vale com resposta, senão grava `stop-failed`. O resumo só usa `started`/`stopped` como efeito. Transações recusadas aparecem numa linha própria.
4. **Fim da entrada por contador cumulativo.** Corrigido: o gerador conta estações distintas registradas agora (`registered`, que cai quando a estação cai) e marca `lastAllRegisteredAt`; `scripts/local-loadtest-tier.sh` espera `registered >= N`, e a reconexão também. O resumo inclui o mínimo de registradas durante o regime.

## Arquivos e comandos

- Gerador: `ocpp-simulator/bench/loadgen.js`.
  - `LT_PW=... taskset -c 8-15 node bench/loadgen.js --url ws://127.0.0.1:18081 --url16 ws://127.0.0.1:18092 --mix16 0.3 --count N --ramp 50 --tx 0.2`
- Bateria completa: `scripts/local-loadtest-all.sh`, que chama `scripts/local-loadtest-tier.sh <rótulo> <N> 50 0.2 0.3`.
- Resumo de um patamar: `scripts/loadtest-summary.py <pasta>`.
- Dados brutos por patamar em `data/{asis,fixed}-{100,500,1000,2000}/`: `loadgen.jsonl`, `metrics.jsonl`, `events.jsonl` e `summary.json`.
- A primeira rodada, só OCPP 2.0.1, ficou em `data/rodada1-somente-201/`; os dados da 2.ª rodada estão no commit a59d6c6.
- Stack local: `~/.config/spotside/lt-stack/docker-compose.json`. Tem senhas do LAB, está com chmod 600 e fora dos repositórios.

## Observações

- **"Tariff not found" no log do gateway:** as estações de teste não têm tarifa. Não afeta o envio.
- **`tx16:idTag:ConcurrentTx`:** o mesmo idTag foi usado numa transação já aberta. É do gerador, que reaproveita idTags; a transação é encerrada e contada como recusada.
- **Auto-registro:** o backend criou um carregador `pending` por estação no banco local, como faria com um carregador real.

## Limpeza

LAB, depois do teste com uma estação (`scripts/loadtest-cleanup-citrine.sql` e `scripts/loadtest-cleanup-csms.sql`):

```
citrine:  select count(*) from "ChargingStations" where id like '7300881%';           -> 0
          select count(*) from "VariableAttributes" where "stationId" like '7300881%';  -> 0
csms_db:  select count(*) from chargers where "citrineChargePointId" like '7300881%';  -> 0
```

O stack local foi derrubado com os volumes (`docker compose down -v`), e com ele as 2000 estações de teste.
