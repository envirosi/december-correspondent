create table edition (
  id serial primary key,
  year int unique not null,
  enrol_close timestamptz not null,
  drawn_at timestamptz,
  created_at timestamptz not null default now()
);

create table reader (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  public_id text unique not null,
  name text not null,
  email text not null,
  zone text not null check (zone in ('Europe/London','Asia/Manila','Australia/Sydney')),
  role text not null default 'reader' check (role in ('reader','editor')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (edition_id, email)
);

create table invitation (
  id serial primary key,
  reader_id int not null references reader on delete cascade,
  digest text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table session (
  id serial primary key,
  reader_id int not null references reader on delete cascade,
  digest text unique not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table door (
  edition_id int not null references edition on delete cascade,
  day int not null check (day between 1 and 24),
  shared_title text not null,
  shared_body text not null,
  optional_prompt text,
  private_title text not null,
  private_body text not null,
  edited_at timestamptz,
  primary key (edition_id, day)
);

create table personal_item (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  recipient_id int not null references reader on delete cascade,
  day int not null check (day between 1 and 24),
  body text not null,
  url text,
  byline text not null,
  author_id int references reader on delete set null,
  status text not null default 'approved' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now()
);
create index on personal_item (recipient_id, day);

create table contribution (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  author_id int not null references reader on delete cascade,
  source_day int not null check (source_day between 1 and 24),
  display_day int not null check (display_day between 1 and 24),
  body text not null,
  media_url text,
  media_desc text,
  consent boolean not null,
  byline text not null,
  state text not null default 'pending' check (state in ('pending','approved','declined','unpublished')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index on contribution (edition_id, display_day, state);

create table enrolment (
  edition_id int not null references edition on delete cascade,
  reader_id int not null references reader on delete cascade,
  wish_like text,
  wish_laugh text,
  wish_discover text,
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  primary key (edition_id, reader_id)
);

create table assignment (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  giver_id int not null references reader on delete cascade,
  recipient_id int not null references reader on delete cascade,
  check (giver_id <> recipient_id),
  unique (edition_id, giver_id),
  unique (edition_id, recipient_id)
);

create table parcel (
  id serial primary key,
  edition_id int not null references edition on delete cascade,
  assignment_id int unique references assignment on delete cascade,
  recipient_id int not null references reader on delete cascade,
  body text not null default '',
  url text,
  sealed_at timestamptz,
  reserve boolean not null default false,
  publish_request boolean not null default false,
  updated_at timestamptz not null default now()
);
