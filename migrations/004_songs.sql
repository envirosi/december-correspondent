alter table nudge drop constraint nudge_kind_check;
alter table nudge add constraint nudge_kind_check check (kind in ('chain','poll','cracker','star','offline','hat','song'));

alter table edition add column playlist_url text;

create table song_request (
  edition_id int not null references edition on delete cascade,
  reader_id int not null references reader on delete cascade,
  zone text not null,
  title text not null,
  artist text,
  updated_at timestamptz not null default now(),
  primary key (edition_id, reader_id)
);
