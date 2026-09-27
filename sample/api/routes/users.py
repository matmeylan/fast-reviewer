def list_users(db):
    return [u for u in db.users if u.active]
