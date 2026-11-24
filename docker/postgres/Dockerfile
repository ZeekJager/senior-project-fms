# The primary database (FMS-108, docs/backups.md#continuous-archiving-and-point-in-time-recovery):
# PostgreSQL 16 with pgBackRest, which archives every WAL segment as it is written and takes the
# weekly full and daily differential base backups that point-in-time recovery starts from.
# pgBackRest comes from the PostgreSQL project's own apt repository, already configured in this image.
# Both database containers, the primary and its standby, run it (FMS-162, docs/disaster-recovery.md): either can be
# promoted, and socat answers the stable endpoint's question of which one is the primary (role-agent.sh).
FROM postgres:16

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest socat tini \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 750 /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest

COPY pgbackrest/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chmod=0755 pgbackrest/entrypoint.sh pgbackrest/backup.sh pgbackrest/scheduler.sh \
     pgbackrest/status.sh pgbackrest/drill.sh pgbackrest/standby.sh pgbackrest/role-agent.sh /usr/local/bin/fms-pgbackrest/

# tini is PID 1, not PostgreSQL: the helpers beside it (role agents, the backup loops) are tini's children, so one
# exiting is never taken by the postmaster for a crashed server process (which restarts the whole server).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fms-pgbackrest/entrypoint.sh"]
CMD ["postgres"]
