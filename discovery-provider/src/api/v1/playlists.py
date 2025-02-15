import logging

from flask.globals import request
from flask_restx import Namespace, Resource, fields, reqparse
from src.api.v1.helpers import (
    abort_bad_path_param,
    abort_bad_request_param,
    decode_with_abort,
    extend_playlist,
    extend_track,
    extend_user,
    get_current_user_id,
    get_default_max,
    make_full_response,
    make_response,
    search_parser,
    success_response,
)
from src.api.v1.models.playlists import full_playlist_model, playlist_model
from src.api.v1.models.users import user_model_full
from src.queries.get_playlist_tracks import get_playlist_tracks
from src.queries.get_playlists import get_playlists
from src.queries.get_reposters_for_playlist import get_reposters_for_playlist
from src.queries.get_savers_for_playlist import get_savers_for_playlist
from src.queries.get_top_playlists import get_top_playlists  # pylint: disable=C0302
from src.queries.get_trending_playlists import (
    TRENDING_LIMIT,
    TRENDING_TTL_SEC,
    get_full_trending_playlists,
    get_trending_playlists,
)
from src.queries.search_queries import SearchKind, search
from src.trending_strategies.trending_strategy_factory import (
    DEFAULT_TRENDING_VERSIONS,
    TrendingStrategyFactory,
)
from src.trending_strategies.trending_type_and_version import TrendingType
from src.utils.db_session import get_db_read_replica
from src.utils.redis_cache import cache
from src.utils.redis_metrics import record_metrics

from .models.tracks import track

logger = logging.getLogger(__name__)

trending_strategy_factory = TrendingStrategyFactory()

ns = Namespace("playlists", description="Playlist related operations")
full_ns = Namespace("playlists", description="Full playlist related operations")

playlists_response = make_response(
    "playlist_response", ns, fields.List(fields.Nested(playlist_model))
)
full_playlists_response = make_full_response(
    "full_playlist_response", full_ns, fields.List(fields.Nested(full_playlist_model))
)


def get_playlist(playlist_id, current_user_id):
    """Returns a single playlist, or None"""
    args = {
        "playlist_id": [playlist_id],
        "with_users": True,
        "current_user_id": current_user_id,
    }
    playlists = get_playlists(args)
    if playlists:
        return extend_playlist(playlists[0])
    return None


def get_tracks_for_playlist(playlist_id, current_user_id=None):
    db = get_db_read_replica()
    with db.scoped_session() as session:
        args = {
            "playlist_ids": [playlist_id],
            "populate_tracks": True,
            "current_user_id": current_user_id,
        }
        playlist_tracks_map = get_playlist_tracks(session, args)
        playlist_tracks = playlist_tracks_map[playlist_id]
        tracks = list(map(extend_track, playlist_tracks))
        return tracks


PLAYLIST_ROUTE = "/<string:playlist_id>"


@ns.route(PLAYLIST_ROUTE)
class Playlist(Resource):
    @record_metrics
    @ns.doc(
        id="""Get Playlist""",
        params={"playlist_id": "A Playlist ID"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @ns.marshal_with(playlists_response)
    @cache(ttl_sec=5)
    def get(self, playlist_id):
        """Fetch a playlist."""
        playlist_id = decode_with_abort(playlist_id, ns)
        playlist = get_playlist(playlist_id, None)
        response = success_response([playlist] if playlist else [])
        return response


playlist_tracks_response = make_response(
    "playlist_tracks_response", ns, fields.List(fields.Nested(track))
)

full_playlist_parser = reqparse.RequestParser()
full_playlist_parser.add_argument("user_id", required=False)


@full_ns.route(PLAYLIST_ROUTE)
class FullPlaylist(Resource):
    @ns.marshal_with(full_playlists_response)
    @cache(ttl_sec=5)
    def get(self, playlist_id):
        """Fetch a playlist."""
        playlist_id = decode_with_abort(playlist_id, full_ns)
        args = full_playlist_parser.parse_args()
        current_user_id = get_current_user_id(args)

        playlist = get_playlist(playlist_id, current_user_id)
        if playlist:
            tracks = get_tracks_for_playlist(playlist_id, current_user_id)
            playlist["tracks"] = tracks
        response = success_response([playlist] if playlist else [])
        return response


@ns.route("/<string:playlist_id>/tracks")
class PlaylistTracks(Resource):
    @record_metrics
    @ns.doc(
        id="""Get Playlist Tracks""",
        params={"playlist_id": "A Playlist ID"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @ns.marshal_with(playlist_tracks_response)
    @cache(ttl_sec=5)
    def get(self, playlist_id):
        """Fetch tracks within a playlist."""
        decoded_id = decode_with_abort(playlist_id, ns)
        tracks = get_tracks_for_playlist(decoded_id)
        return success_response(tracks)


playlist_search_result = make_response(
    "playlist_search_result", ns, fields.List(fields.Nested(playlist_model))
)


@ns.route("/search")
class PlaylistSearchResult(Resource):
    @record_metrics
    @ns.doc(
        id="""Search Playlists""",
        params={"query": "Search Query"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @ns.marshal_with(playlist_search_result)
    @ns.expect(search_parser)
    @cache(ttl_sec=600)
    def get(self):
        """Search for a playlist."""
        args = search_parser.parse_args()
        query = args["query"]
        if not query:
            abort_bad_request_param("query", ns)
        search_args = {
            "query": query,
            "kind": SearchKind.playlists.name,
            "is_auto_complete": False,
            "current_user_id": None,
            "with_users": True,
            "limit": 10,
            "offset": 0,
        }
        response = search(search_args)
        playlists = list(map(extend_playlist, response["playlists"]))
        return success_response(playlists)


top_parser = reqparse.RequestParser()
top_parser.add_argument("type", required=True)
top_parser.add_argument("limit", required=False, type=int)
top_parser.add_argument("offset", required=False, type=int)


@ns.route("/top", doc=False)
class Top(Resource):
    @record_metrics
    @ns.doc(
        id="""Top Playlists""",
        params={"type": "album or playlist", "limit": "limit", "offset": "offset"},
    )
    @ns.marshal_with(playlists_response)
    @cache(ttl_sec=30 * 60)
    def get(self):
        """Gets top playlists."""
        args = top_parser.parse_args()
        if args.get("limit") is None:
            args["limit"] = 100
        else:
            args["limit"] = min(args.get("limit"), 100)
        if args.get("offset") is None:
            args["offset"] = 0
        if args.get("type") not in ["album", "playlist"]:
            abort_bad_request_param("type", ns)

        args["with_users"] = True

        response = get_top_playlists(args.type, args)

        playlists = list(map(extend_playlist, response))
        return success_response(playlists)


playlist_favorites_route_parser = reqparse.RequestParser()
playlist_favorites_route_parser.add_argument("user_id", required=False)
playlist_favorites_route_parser.add_argument("limit", required=False, type=int)
playlist_favorites_route_parser.add_argument("offset", required=False, type=int)
playlist_favorites_response = make_full_response(
    "following_response", full_ns, fields.List(fields.Nested(user_model_full))
)


@full_ns.route("/<string:playlist_id>/favorites")
class FullTrackFavorites(Resource):
    @full_ns.expect(playlist_favorites_route_parser)
    @full_ns.doc(
        id="""Get Users that Favorited a Playlist""",
        params={"user_id": "A User ID", "limit": "Limit", "offset": "Offset"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @full_ns.marshal_with(playlist_favorites_response)
    @cache(ttl_sec=5)
    def get(self, playlist_id):
        args = playlist_favorites_route_parser.parse_args()
        decoded_id = decode_with_abort(playlist_id, full_ns)
        limit = get_default_max(args.get("limit"), 10, 100)
        offset = get_default_max(args.get("offset"), 0)
        current_user_id = get_current_user_id(args)
        args = {
            "save_playlist_id": decoded_id,
            "current_user_id": current_user_id,
            "limit": limit,
            "offset": offset,
        }
        users = get_savers_for_playlist(args)
        users = list(map(extend_user, users))

        return success_response(users)


playlist_reposts_route_parser = reqparse.RequestParser()
playlist_reposts_route_parser.add_argument("user_id", required=False)
playlist_reposts_route_parser.add_argument("limit", required=False, type=int)
playlist_reposts_route_parser.add_argument("offset", required=False, type=int)
playlist_reposts_response = make_full_response(
    "following_response", full_ns, fields.List(fields.Nested(user_model_full))
)


@full_ns.route("/<string:playlist_id>/reposts")
class FullPlaylistReposts(Resource):
    @full_ns.expect(playlist_reposts_route_parser)
    @full_ns.doc(
        id="""Get Users that Reposted a Playlist""",
        params={"user_id": "A User ID", "limit": "Limit", "offset": "Offset"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @full_ns.marshal_with(playlist_reposts_response)
    @cache(ttl_sec=5)
    def get(self, playlist_id):
        args = playlist_reposts_route_parser.parse_args()
        decoded_id = decode_with_abort(playlist_id, full_ns)
        limit = get_default_max(args.get("limit"), 10, 100)
        offset = get_default_max(args.get("offset"), 0)
        current_user_id = get_current_user_id(args)
        args = {
            "repost_playlist_id": decoded_id,
            "current_user_id": current_user_id,
            "limit": limit,
            "offset": offset,
        }
        users = get_reposters_for_playlist(args)
        users = list(map(extend_user, users))
        return success_response(users)


trending_response = make_response(
    "trending_playlists_response", ns, fields.List(fields.Nested(playlist_model))
)
trending_parser = reqparse.RequestParser()
trending_parser.add_argument("time", required=False)


@ns.route(
    "/trending",
    defaults={"version": DEFAULT_TRENDING_VERSIONS[TrendingType.PLAYLISTS].name},
    strict_slashes=False,
)
@ns.route("/trending/<string:version>")
class TrendingPlaylists(Resource):
    @record_metrics
    @ns.doc(
        id="""Trending Playlists""",
        params={"time": "time range to query"},
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @ns.expect(trending_parser)
    @ns.marshal_with(trending_response)
    @cache(ttl_sec=TRENDING_TTL_SEC)
    def get(self, version):
        """Gets top trending playlists for time period on Audius"""
        trending_playlist_versions = trending_strategy_factory.get_versions_for_type(
            TrendingType.PLAYLISTS
        ).keys()
        version_list = list(
            filter(lambda v: v.name == version, trending_playlist_versions)
        )
        if not version_list:
            abort_bad_path_param("version", ns)

        args = trending_parser.parse_args()
        time = args.get("time")
        time = "week" if time not in ["week", "month", "year"] else time
        args = {"time": time, "with_tracks": False}
        strategy = trending_strategy_factory.get_strategy(
            TrendingType.PLAYLISTS, version_list[0]
        )
        playlists = get_trending_playlists(args, strategy)
        playlists = playlists[:TRENDING_LIMIT]
        playlists = list(map(extend_playlist, playlists))

        return success_response(playlists)


full_trending_playlists_response = make_full_response(
    "full_trending_playlists_response",
    full_ns,
    fields.List(fields.Nested(full_playlist_model)),
)

full_trending_parser = trending_parser.copy()
full_trending_parser.add_argument("time", required=False)
full_trending_parser.add_argument("limit", required=False)
full_trending_parser.add_argument("offset", required=False)
full_trending_parser.add_argument("user_id", required=False)


@full_ns.route(
    "/trending",
    defaults={"version": DEFAULT_TRENDING_VERSIONS[TrendingType.PLAYLISTS].name},
    strict_slashes=False,
)
@full_ns.route("/trending/<string:version>")
class FullTrendingPlaylists(Resource):
    @full_ns.expect(full_trending_parser)
    @full_ns.doc(
        id="""Returns trending playlists for a time period based on the given trending version""",
        params={
            "user_id": "A User ID",
            "limit": "Limit",
            "offset": "Offset",
            "time": "week / month / year",
        },
        responses={200: "Success", 400: "Bad request", 500: "Server error"},
    )
    @record_metrics
    @full_ns.marshal_with(full_trending_playlists_response)
    def get(self, version):
        """Get trending playlists"""
        trending_playlist_versions = trending_strategy_factory.get_versions_for_type(
            TrendingType.PLAYLISTS
        ).keys()
        version_list = list(
            filter(lambda v: v.name == version, trending_playlist_versions)
        )
        if not version_list:
            abort_bad_path_param("version", full_ns)

        args = full_trending_parser.parse_args()
        strategy = trending_strategy_factory.get_strategy(
            TrendingType.PLAYLISTS, version_list[0]
        )
        playlists = get_full_trending_playlists(request, args, strategy)
        return success_response(playlists)
