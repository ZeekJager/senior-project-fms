# The primary database (FMS-108, docs/backups.md#continuous-archiving-and-point-in-time-recovery):
# PostgreSQL 16 with pgBackRest, which archives every WAL segment as it is written and takes the
# weekly full and daily differential base backups that point-in-time recovery starts from.
# pgBackRest comes from the PostgreSQL project's own apt repository, already configured in this image.
FROM postgres:16

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 750 /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest

COPY pgbackrest/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chmod=0755 pgbackrest/entrypoint.sh pgbackrest/backup.sh pgbackrest/scheduler.sh /usr/local/bin/fms-pgbackrest/

ENTRYPOINT ["/usr/local/bin/fms-pgbackrest/entrypoint.sh"]
CMD ["postgres"]
