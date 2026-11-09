#!/usr/bin/env bash
# Samples the local load-test stack every 15 s into a JSONL file:
# docker stats per service, Postgres (connections, statements/s and mean
# statement time from pg_stat_statements, deltas over the window) and
# RabbitMQ (publish/deliver/ack rates and queued messages from the
# management API).
# usage: local-loadtest-metrics.sh <out.jsonl>
OUT=$1; C="docker compose -f $HOME/.config/spotside/lt-stack/docker-compose.json"
MQ_USER=$($C exec -T amqp-broker printenv RABBITMQ_DEFAULT_USER)
MQ_PASS=$($C exec -T amqp-broker printenv RABBITMQ_DEFAULT_PASS)
PREV_CALLS=0; PREV_TIME=0; PREV_AT=$(date +%s.%N)
while true; do
  STATS=$(docker stats --no-stream --format '{"n":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}"}' $(docker ps -q --filter name=csms-loadtest) | paste -sd, -)
  PG=$($C exec -T postgres psql -U csms -d postgres -At -c "select coalesce(string_agg(datname||':'||coalesce(state,'-')||':'||n,' '),'') from (select datname,state,count(*) n from pg_stat_activity where datname is not null group by 1,2) x" 2>/dev/null)
  read CALLS TIME MAXMEAN <<< "$($C exec -T postgres psql -U csms -d postgres -At -F' ' -c "select coalesce(sum(calls),0), coalesce(sum(total_exec_time),0), coalesce(max(mean_exec_time) filter (where calls>50),0) from pg_stat_statements" 2>/dev/null)"
  AT=$(date +%s.%N)
  PGQ=$(python3 -c "
dc=$CALLS-$PREV_CALLS; dt=$TIME-$PREV_TIME; w=$AT-$PREV_AT
print('{\"qps\":%.1f,\"meanMs\":%.3f,\"worstStmtMeanMs\":%.2f}'%(dc/w if w>0 else 0, dt/dc if dc>0 else 0, $MAXMEAN))")
  PREV_CALLS=$CALLS; PREV_TIME=$TIME; PREV_AT=$AT
  MQ=$(curl -s -u "$MQ_USER:$MQ_PASS" http://127.0.0.1:15672/api/overview | python3 -c "
import json,sys
d=json.load(sys.stdin);m=d.get('message_stats',{});q=d.get('queue_totals',{})
r=lambda k:round(m.get(k,{}).get('rate',0),1)
print(json.dumps({'publishPerS':r('publish_details'),'deliverPerS':r('deliver_get_details'),'ackPerS':r('ack_details'),'queued':q.get('messages',0),'unacked':q.get('messages_unacknowledged',0)}))" 2>/dev/null || echo '{}')
  printf '{"at":"%s","stats":[%s],"pg":"%s","pgq":%s,"mq":%s}\n' "$(date -u +%FT%TZ)" "$STATS" "$PG" "$PGQ" "$MQ" >> "$OUT"
  sleep 15
done
