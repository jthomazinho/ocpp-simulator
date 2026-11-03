# Teste de carga do gateway OCPP: 03/11/2026 (card 69c5b5e7)

## Resposta curta

- **Hoje (configuração do LAB e do PROD):** 1 cópia do gateway não sustenta nem 100 carregadores.
  - O pool do Postgres do gateway está no padrão de 5 conexões.
  - Numa rajada ele esgota, o erro não é tratado e o processo cai, levando todos os carregadores juntos.
  - Com 1000 carregadores, em 10 minutos só 619 conseguem registrar (Boot aceito). Com 2000, só 117.
- **Com as correções** (pool 20, correção da queda e limite de 20 conexões novas por segundo):
  - 1 cópia sustenta **1000 carregadores**: entram em 70 s, zero quedas, RemoteStart e RemoteStop efetivos em 185 a 334 ms, reconexão total 87 s depois de um restart;
  - e **2000 em regime**: zero quedas, mediana de 41 ms por chamada.
  - O limite passa a ser a rajada de Boots de 2000 estações juntas: em 30 s só cerca de metade recebe resposta. Para 2000, a recomendação é baixar o ritmo de entrada ou ter 2 cópias.

## Onde rodou e por quê

- **Fora do LAB.** O nó do LAB (`lab-power-manager-01`) tem hoje **1,9 GB de RAM** (`docker info`: MemTotal 1939 MB, 4 CPUs) e usa **82%** parado, com 600 MB em swap. O card manda parar acima de 80%, então no LAB o teste mediria swap e não o gateway. Decisão da Cileide em 03/11 (opção 3): rodar uma cópia do stack do LAB nesta máquina.
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

"Regime" é a média das amostras de 30 s depois de terminada a entrada até o restart. CPU em % de um núcleo.

### A. Como está hoje: gateway do LAB, pool padrão (5), sem proteção

| | 100 | 500 | 1000 | 2000 |
|---|---|---|---|---|
| Registrados (Boot aceito) ao fim da entrada | 127 de 100* em 70 s | 581* em 180 s | **619 de 1000** em 10 min | **117 de 2000** em 10 min |
| Quedas de conexão antes do restart | 85 | **1750** | 700 | 99 |
| Boots fora do tempo (30 s) | 35 | 792 | 1810 | 3771 |
| Chamadas em regime (p50 / p95) | 8,5 / 24 ms | 29 / 6350 ms | 13 / 28 ms | 25 / 50 ms |
| RemoteStart/Stop com efeito | 19 de 19 (185 a 2117 ms) | **8 de 15** (2,3 a 14,8 s) | 18 de 18 | 19 de 19 |
| Registrados depois do restart | 100 de 100 | 500 de 500 | **271 de 1000** | **211 de 2000** |
| Gateway CPU regime / pico, RAM | 5% / 127%, 197 MB | 37% / 138%, 436 MB | 12% / 145%, 328 MB | 7% / 137%, 279 MB |
| Postgres: consultas/s, ms por consulta, conexões | 138, 0,044, 23 | 530, 0,064, 19 | 238, 0,053, 20 | 109, 0,053, 24 |
| RabbitMQ: publicadas/s em regime (pico), maior fila | 7,8 (77), 65 | 52,6 (223), 624 | 21,8 (147), 648 | 7,0 (110), 81 |

\* Mais Boots que estações: o gateway cai, a estação reconecta e faz Boot de novo.

**Causa:**
- O pool do Postgres do gateway é o padrão de 5. Nem o LAB nem o PROD definem `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX`; conferi o PROD só por leitura.
- Numa rajada, o `SequelizeConnectionAcquireTimeoutError` sai de `WebhookDispatcher.dispatchMessageReceived`, chamado em `MessageRouterImpl.onMessage`.
- O handler do WebSocket não aguarda essa chamada, então a rejeição fica sem tratamento e **o processo sai** (log: `ConnectionAcquireTimeoutError ... Node.js v24.4.1` seguido de `Executing DB strategy: migrate`).
- Em 1000 e 2000 sobra pouca gente registrada para gerar carga em regime. Por isso o regime desses dois patamares é baixo: não é folga.

### B. Corrigido: pool 20 + correção da queda + proteção a 20/s (rajada 50)

Imagem do gateway montada sobre a main do gateway (`9e95199`) com `fix/gateway-ws-protection` e `fix/gateway-crash-on-pool-timeout`. Com `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20`.

| | 100 | 500 | 1000 | 2000 |
|---|---|---|---|---|
| Registrados ao fim da entrada | 100 em 30 s | 500 em 30 s | **1000 em 70 s** | **1061 de 2000** em 10 min (ver nota) |
| Boot p95 | 3,3 s | 5,1 s | 15,9 s | acima de 30 s (1890 fora do tempo) |
| Quedas de conexão antes do restart | **0** | **0** | **0** | **0** |
| Recusas 503 (proteção espaçando a entrada) | 20 | 856 | 3250 | 10035 |
| Chamadas em regime (p50 / p95) | 9 / 26 ms | 10 / 28 ms | 14 / 43 ms | 41 / 94 ms |
| RemoteStart/Stop: chegada à estação | 135 a 173 ms | 151 a 247 ms | 151 a 253 ms | 173 a 396 ms |
| RemoteStart/Stop: transação iniciada ou parada | 18 de 18, 147 a 194 ms | 19 de 19, 171 a 292 ms | 18 de 18, 185 a 334 ms | 19 de 19, 231 a 840 ms |
| Reconexão de todas após restart | 8 s | 43 s | 87 s | 124 s |
| Registrados depois do restart | 100 | 500 | 1000 | 1049 |
| Gateway CPU regime / pico, RAM | 6% / 110%, 199 MB | 15% / 123%, 375 MB | 28% / 118%, 401 MB | 41% / 111%, 409 MB |
| Backend CPU regime, RAM | 15%, 116 MB | 11%, 115 MB | 11%, 117 MB | 10%, 120 MB |
| Postgres CPU regime, RAM | 2%, 159 MB | 9%, 162 MB | 18%, 178 MB | 25%, 236 MB |
| Postgres: consultas/s, ms por consulta (pico), conexões | 136, 0,057 (0,095), 31 | 325, 0,058 (0,078), 38 | 578, 0,065 (0,132), 40 | 615, 0,139 (0,235), 36 |
| RabbitMQ CPU regime, RAM | 2%, 269 MB | 12%, 271 MB | 36%, 297 MB | **99%**, 486 MB |
| RabbitMQ: publicadas/entregues por s, maior fila | 7,2 / 7,5, 0 | 37 / 36, 1 | 71 / 71, 4 | 75 / 78, 4 |
| Transações em andamento em regime | 14 | 99 | 189 | 216 |
| Memória do stack (pico) | 937 MB | 1,0 GB | 1,1 GB | 1,3 GB |

- Nos quatro patamares não houve nenhuma queda do processo.
- A consulta mais lenta do Postgres ficou em cerca de 12 ms de média em todos os patamares; é sempre a mesma, de manutenção.

**Nota sobre 2000:**
- A proteção deixa as 2000 estações conectarem em cerca de 100 s, mas o Boot passa de 30 s para cerca de metade delas.
- O gerador não repete um Boot que passou do tempo, e por isso só 1061 aparecem registradas. Um carregador real repete o Boot, e o número final seria maior, mas mais lento.
- Com 2000 em regime, o RabbitMQ chega a um núcleo inteiro. Ele divide os 4 núcleos com o gateway e o Postgres, e é o primeiro serviço a saturar.

## Conclusão

**Limite prático de 1 cópia:**
- **Hoje:** abaixo de 100. Com 100 o gateway já cai, e isso vale para o PROD, que tem a mesma configuração.
- **Com as correções:** 1000 com folga. Em 2000 o regime aguenta, mas a entrada em massa passa do tempo do Boot.

**Ordem recomendada das etapas 2 a 6:**
1. **Antes de tudo (obrigatório, barato):**
   - `BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20` no stack;
   - a correção da queda (card 26140c80, `fix/gateway-crash-on-pool-timeout`).
   - Sem os dois, o gateway cai com 100 carregadores.
2. **Etapa 2, 65a03b5e (proteção do WebSocket):** necessária a partir de cerca de 1000. Padrão ajustado para 20/s, rajada 50, que foi o valor medido.
3. **Etapa 3, fe3f07b8 (limites por serviço), com os números de 1000 a 2000:**
   - gateway: reserva de 1 núcleo e 512 MB, limite de 1 GB;
   - RabbitMQ: reserva de 1 núcleo e limite de 1 GB (chegou a 99% de um núcleo em 2000);
   - Postgres: reserva de 0,5 núcleo e limite de 1 GB;
   - backend: 512 MB;
   - `nofile` 65536 no gateway.
4. **Etapas 4 e 5 (Redis + HAProxy com 2 cópias):** passam a ser necessárias para 2000, para dividir a rajada de Boots. Até 1000, servem só para disponibilidade (deploy sem derrubar a frota).
5. **Etapa 6, ac009994 (várias cópias do backend + PgBouncer):** o backend ficou em 10 a 15% de um núcleo e 120 MB em todos os patamares, e o Postgres com até 40 conexões e 0,06 a 0,14 ms por consulta. Não é gargalo até 2000.

## Achados da revisão cruzada de 03/11 e o que foi feito

1. **"Não mede os quatro patamares da cópia atual; os maiores usam outra configuração e 2000 é extrapolação."** Corrigido: os quatro patamares rodaram nas duas configurações (tabelas A e B), e 2000 foi medido. A configuração atual é a tabela A. Sobre o LAB: não é possível nele, pelos 1,9 GB de RAM medidos; ver "Onde rodou e por quê".
2. **"Relatório fora do commit; faltam tempo de query e filas/mensagens por segundo."** Corrigido: tempo médio por consulta e consultas/s do Postgres (`pg_stat_statements`), mensagens publicadas e entregues por segundo e maior fila do RabbitMQ estão nas tabelas. Relatório, roteiros e dados brutos estão commitados em `ocpp-simulator/docs/loadtest-2026-11-03/`.
3. **"Não cobre OCPP 1.6."** Corrigido: frota mista com 30% em OCPP 1.6 na porta 8092, com RemoteStart e RemoteStop em 1.6 medidos em todos os patamares.
4. **"RemoteStart/Stop aceitos sem mudar a transação."** Corrigido: o gerador inicia e para a transação de verdade (Started/StartTransaction e Ended/StopTransaction) e recusa o stop de outra transação. A tabela separa a chegada do comando do efeito na transação.

## Arquivos e comandos

- Gerador: `ocpp-simulator/bench/loadgen.js`.
  - `LT_PW=... taskset -c 8-15 node bench/loadgen.js --url ws://127.0.0.1:18081 --url16 ws://127.0.0.1:18092 --mix16 0.3 --count N --ramp 50 --tx 0.2`
- Bateria completa: `scripts/local-loadtest-all.sh`, que chama `scripts/local-loadtest-tier.sh <rótulo> <N> 50 0.2 0.3`.
- Resumo de um patamar: `scripts/loadtest-summary.py <pasta>`.
- Dados brutos por patamar em `md/loadtest-2026-11-03/{asis,fixed}-{100,500,1000,2000}/`: `loadgen.jsonl`, `metrics.jsonl`, `events.jsonl` e `summary.json`.
- A primeira rodada, só OCPP 2.0.1, ficou em `rodada1-somente-201/`.
- Stack local: `~/.config/spotside/lt-stack/docker-compose.json`. Tem senhas do LAB, está com chmod 600 e fora dos repositórios.

## Observações

- **"Tariff not found" no log do gateway:** as estações de teste não têm tarifa. Não afeta o envio.
- **`tx16:idTag:ConcurrentTx`:** o mesmo idTag foi usado numa transação já aberta. É esperado no gerador.
- **Auto-registro:** o backend criou um carregador `pending` por estação no banco local, como faria com um carregador real.

## Limpeza

LAB, depois do teste com uma estação (`scripts/loadtest-cleanup-citrine.sql` e `scripts/loadtest-cleanup-csms.sql`):

```
citrine:  select count(*) from "ChargingStations" where id like '7300881%';           -> 0
          select count(*) from "VariableAttributes" where "stationId" like '7300881%';  -> 0
csms_db:  select count(*) from chargers where "citrineChargePointId" like '7300881%';  -> 0
```

O stack local foi derrubado com os volumes (`docker compose down -v`), e com ele as 2000 estações de teste.
