alter table reader add column notify_post boolean not null default true;
alter table reader add column notify_weekly boolean not null default true;
alter table reader add column email_token text;
alter table reader add column last_post_email_on date;
create unique index reader_email_token on reader (email_token);

alter table personal_item add column notified_at timestamptz;
alter table parcel add column notified_at timestamptz;

create table weekly_sent (
  edition_id int not null references edition on delete cascade,
  reader_id int not null references reader on delete cascade,
  week text not null,
  sent_at timestamptz not null default now(),
  primary key (edition_id, reader_id, week)
);

create table email_log (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  kind text not null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
