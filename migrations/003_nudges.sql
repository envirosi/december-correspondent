alter table personal_item add column kind text not null default 'letter' check (kind in ('letter','cracker','star'));

create table nudge (
  edition_id int not null references edition on delete cascade,
  day int not null check (day between 1 and 24),
  kind text not null check (kind in ('chain','poll','cracker','star','offline','hat')),
  title text not null,
  body text not null,
  options jsonb,
  primary key (edition_id, day)
);

create table poll_vote (
  edition_id int not null references edition on delete cascade,
  day int not null,
  reader_id int not null references reader on delete cascade,
  choice int not null,
  created_at timestamptz not null default now(),
  primary key (edition_id, day, reader_id)
);

create table chain_link (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  reader_id int not null references reader on delete cascade,
  zone text not null,
  body text not null,
  state text not null default 'pending' check (state in ('pending','approved','hidden')),
  created_at timestamptz not null default now()
);
create index on chain_link (edition_id, state);

create table hat (
  edition_id int not null references edition on delete cascade,
  day int not null,
  reader_id int not null references reader on delete cascade,
  created_at timestamptz not null default now(),
  primary key (edition_id, day, reader_id)
);
