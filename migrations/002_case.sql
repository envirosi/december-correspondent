create table case_entry (
  edition_id int not null references edition on delete cascade,
  day int not null check (day between 1 and 24),
  title text not null,
  body text not null,
  theory text,
  primary key (edition_id, day)
);

create table case_clue (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  day int not null check (day between 1 and 24),
  seq int not null,
  clue text not null,
  note text
);
create index on case_clue (edition_id, day);

create table case_suspect (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  day int not null check (day between 1 and 24),
  seq int not null,
  suspect text not null,
  status text not null,
  note text
);
create index on case_suspect (edition_id, day);
