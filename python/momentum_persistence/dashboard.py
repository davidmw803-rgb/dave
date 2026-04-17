"""
Streamlit dashboard for momentum persistence analysis.

Three tabs:
  1. Run Analysis — pick source + params, hit go, see report
  2. History — browse past runs from Supabase, filter, sort, delete
  3. Charts — track how edge / hit rate evolves over time per ticker

Run with:
  streamlit run dashboard.py
"""

import os
from datetime import datetime, timezone

import altair as alt
import pandas as pd
import streamlit as st

from momentum_persistence import (
    analyze,
    classify_candles,
    get_supabase_client,
    load_csv,
    load_supabase,
    load_yfinance,
    save_run_to_supabase,
)

st.set_page_config(
    page_title="Momentum Persistence",
    page_icon="📈",
    layout="wide",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@st.cache_data(ttl=60)
def fetch_run_history(limit: int = 500) -> pd.DataFrame:
    """Pull historical analysis runs from Supabase."""
    try:
        client = get_supabase_client()
    except SystemExit:
        return pd.DataFrame()

    response = (
        client.table("momentum_analysis_runs")
        .select("*")
        .order("run_at", desc=True)
        .limit(limit)
        .execute()
    )
    df = pd.DataFrame(response.data or [])
    if not df.empty and "run_at" in df.columns:
        df["run_at"] = pd.to_datetime(df["run_at"])
    return df


def supabase_configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL")) and bool(
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    )


def render_report_metrics(r: dict) -> None:
    """Header KPIs for an analysis result."""
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Candles", r["n_candles"])
    col2.metric(
        "Hit Rate (follow prev)",
        f"{r['hit_rate_follow_prev']:.1%}",
        delta=f"{(r['hit_rate_follow_prev'] - 0.5):+.1%} vs coinflip",
    )
    col3.metric("Expectancy", f"{r['strategy_expectancy']:+.4f}")
    col4.metric(
        "Verdict",
        "POSITIVE" if r["strategy_expectancy"] > 0 else "NEGATIVE",
    )


def render_report_detail(r: dict) -> None:
    left, right = st.columns(2)

    with left:
        st.subheader("Conditional Probabilities")
        st.write(f"**P(up | prev up)**: {r['p_up_given_prev_up']:.1%}")
        st.write(f"**P(down | prev down)**: {r['p_down_given_prev_down']:.1%}")
        st.write(f"**Base rate up**: {r['base_rate_up']:.1%}")
        st.write(f"**Base rate down**: {r['base_rate_down']:.1%}")

        st.subheader("Runs")
        st.write(f"**Longest up run**: {r['longest_up_run']}")
        st.write(f"**Longest down run**: {r['longest_down_run']}")

    with right:
        st.subheader("Transition Matrix")
        matrix = pd.DataFrame(
            {
                "Next Up": [r["uu"], r["du"]],
                "Next Down": [r["ud"], r["dd"]],
            },
            index=["Prev Up", "Prev Down"],
        )
        st.dataframe(matrix, use_container_width=True)

        st.subheader("Strategy P&L")
        st.write(f"**Win rate**: {r['strategy_win_rate']:.1%}")
        st.write(f"**Avg win**: {r['strategy_avg_win']:+.4f}")
        st.write(f"**Avg loss**: {r['strategy_avg_loss']:+.4f}")
        st.write(f"**Avg P&L per bet**: {r['strategy_avg_pnl_per_bet']:+.4f}")


# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------

with st.sidebar:
    st.title("📈 Momentum Persistence")
    st.caption("Does the next candle follow the last one?")
    st.divider()

    if supabase_configured():
        st.success("Supabase: connected")
    else:
        st.warning("Supabase: not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env to save runs.")

    st.divider()
    st.caption("Tip: same `analyze()` function powers the CLI and this UI.")


# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------

tab_run, tab_history, tab_charts = st.tabs(["▶ Run Analysis", "📜 History", "📊 Charts"])


# =============================================================================
# TAB 1: Run Analysis
# =============================================================================

with tab_run:
    st.header("Run a new analysis")

    source = st.radio(
        "Data source",
        ["yfinance", "CSV upload", "Supabase table"],
        horizontal=True,
    )

    df = None
    label = ""
    source_key = ""

    if source == "yfinance":
        col1, col2, col3 = st.columns([2, 1, 1])
        with col1:
            ticker = st.text_input("Ticker", value="SPY", help="e.g. SPY, BTC-USD, ES=F")
        with col2:
            days = st.number_input("Lookback days", min_value=1, value=365)
        with col3:
            interval = st.selectbox(
                "Interval",
                ["1d", "1h", "30m", "15m", "5m", "1m"],
                index=0,
                help="Intraday intervals have shorter max history.",
            )

        if st.button("Fetch & analyze", type="primary"):
            with st.spinner(f"Fetching {ticker}..."):
                try:
                    df = load_yfinance(ticker, int(days), interval)
                    label = f"{ticker} ({interval}, {days}d)"
                    source_key = "yfinance"
                except Exception as e:
                    st.error(f"Failed to load: {e}")

    elif source == "CSV upload":
        uploaded = st.file_uploader("CSV with open, close columns", type=["csv"])
        if uploaded is not None:
            try:
                df_raw = pd.read_csv(uploaded)
                df_raw.columns = [c.lower().strip() for c in df_raw.columns]
                if not {"open", "close"}.issubset(df_raw.columns):
                    st.error(f"CSV must have open, close columns. Got: {list(df_raw.columns)}")
                else:
                    df = df_raw
                    label = uploaded.name
                    source_key = "csv"
                    st.success(f"Loaded {len(df)} rows.")
            except Exception as e:
                st.error(f"Failed to parse CSV: {e}")

    else:  # Supabase table
        if not supabase_configured():
            st.error("Configure Supabase in .env first.")
        else:
            col1, col2, col3 = st.columns([2, 2, 1])
            with col1:
                table = st.text_input("Table name", value="ohlc_candles")
            with col2:
                symbol = st.text_input("Symbol filter (optional)", value="")
            with col3:
                limit = st.number_input("Row limit", min_value=0, value=0, help="0 = no limit")

            if st.button("Load & analyze", type="primary"):
                with st.spinner(f"Reading from Supabase..."):
                    try:
                        df = load_supabase(
                            table,
                            symbol=symbol or None,
                            limit=int(limit) if limit > 0 else None,
                        )
                        label = f"{table}" + (f" [{symbol}]" if symbol else "")
                        source_key = "supabase"
                    except Exception as e:
                        st.error(f"Failed to load: {e}")

    # Run analysis if we got data
    if df is not None and len(df) > 1:
        keep_dojis = st.checkbox("Keep doji candles (zero body)", value=False)

        try:
            r = analyze(df, drop_dojis=not keep_dojis)
        except Exception as e:
            st.error(f"Analysis failed: {e}")
            r = None

        if r:
            st.divider()
            st.subheader(f"Results: {label}")
            render_report_metrics(r)
            st.divider()
            render_report_detail(r)

            # Visualize the candle direction sequence
            st.divider()
            st.subheader("Candle Direction Sequence")
            direction = classify_candles(df)
            seq_df = pd.DataFrame({
                "index": range(len(direction)),
                "direction": direction.values,
                "label": ["Up" if d > 0 else "Down" if d < 0 else "Doji" for d in direction],
            })
            chart = (
                alt.Chart(seq_df)
                .mark_rect()
                .encode(
                    x=alt.X("index:O", axis=None),
                    color=alt.Color(
                        "label:N",
                        scale=alt.Scale(
                            domain=["Up", "Down", "Doji"],
                            range=["#16a34a", "#dc2626", "#9ca3af"],
                        ),
                        legend=alt.Legend(title="Candle"),
                    ),
                    tooltip=["index", "label"],
                )
                .properties(height=60)
            )
            st.altair_chart(chart, use_container_width=True)

            # Save to Supabase
            if supabase_configured():
                st.divider()
                if st.button("💾 Save run to Supabase"):
                    try:
                        save_run_to_supabase(r, source=source_key, label=label)
                        st.success("Saved. Refresh the History tab to see it.")
                        fetch_run_history.clear()  # bust cache
                    except Exception as e:
                        st.error(f"Save failed: {e}")


# =============================================================================
# TAB 2: History
# =============================================================================

with tab_history:
    st.header("Run history")

    if not supabase_configured():
        st.info("Configure Supabase to view run history.")
    else:
        if st.button("🔄 Refresh"):
            fetch_run_history.clear()

        history = fetch_run_history()

        if history.empty:
            st.info("No runs saved yet. Run an analysis and save it to populate this view.")
        else:
            # Filters
            col1, col2, col3 = st.columns(3)
            with col1:
                source_filter = st.multiselect(
                    "Source",
                    options=sorted(history["source"].unique().tolist()),
                    default=sorted(history["source"].unique().tolist()),
                )
            with col2:
                label_search = st.text_input("Label contains", value="")
            with col3:
                verdict_filter = st.selectbox(
                    "Verdict",
                    ["All", "Positive expectancy", "Negative expectancy"],
                )

            filtered = history[history["source"].isin(source_filter)]
            if label_search:
                filtered = filtered[
                    filtered["label"].str.contains(label_search, case=False, na=False)
                ]
            if verdict_filter == "Positive expectancy":
                filtered = filtered[filtered["strategy_expectancy"] > 0]
            elif verdict_filter == "Negative expectancy":
                filtered = filtered[filtered["strategy_expectancy"] <= 0]

            st.caption(f"{len(filtered)} of {len(history)} runs")

            # Display
            display_cols = [
                "run_at", "label", "source", "n_candles",
                "hit_rate_follow_prev", "strategy_expectancy",
                "longest_up_run", "longest_down_run",
            ]
            display_cols = [c for c in display_cols if c in filtered.columns]

            st.dataframe(
                filtered[display_cols],
                use_container_width=True,
                hide_index=True,
                column_config={
                    "run_at": st.column_config.DatetimeColumn("Run At", format="MMM D, YYYY h:mm a"),
                    "hit_rate_follow_prev": st.column_config.NumberColumn("Hit Rate", format="%.1f%%"),
                    "strategy_expectancy": st.column_config.NumberColumn("Expectancy", format="%.4f"),
                    "n_candles": st.column_config.NumberColumn("N"),
                },
            )

            # Inspect individual run
            st.divider()
            st.subheader("Inspect a run")
            if len(filtered) > 0:
                run_options = {
                    f"{row['run_at']:%Y-%m-%d %H:%M} — {row['label']}": row["id"]
                    for _, row in filtered.iterrows()
                }
                selected = st.selectbox("Pick a run", options=list(run_options.keys()))
                if selected:
                    row = filtered[filtered["id"] == run_options[selected]].iloc[0].to_dict()
                    render_report_metrics(row)
                    render_report_detail(row)


# =============================================================================
# TAB 3: Charts
# =============================================================================

with tab_charts:
    st.header("Edge over time")

    if not supabase_configured():
        st.info("Configure Supabase to view charts.")
    else:
        history = fetch_run_history()

        if history.empty:
            st.info("No runs saved yet.")
        else:
            # Pick which labels to chart
            available_labels = sorted(history["label"].unique().tolist())
            selected_labels = st.multiselect(
                "Tickers / labels to compare",
                options=available_labels,
                default=available_labels[:5] if len(available_labels) >= 5 else available_labels,
            )

            metric = st.radio(
                "Metric",
                ["hit_rate_follow_prev", "strategy_expectancy", "p_up_given_prev_up", "p_down_given_prev_down"],
                horizontal=True,
                format_func=lambda x: {
                    "hit_rate_follow_prev": "Hit Rate",
                    "strategy_expectancy": "Expectancy",
                    "p_up_given_prev_up": "P(up | prev up)",
                    "p_down_given_prev_down": "P(down | prev down)",
                }[x],
            )

            if selected_labels:
                chart_data = history[history["label"].isin(selected_labels)].copy()
                chart_data = chart_data[["run_at", "label", metric]].dropna()

                if not chart_data.empty:
                    line_chart = (
                        alt.Chart(chart_data)
                        .mark_line(point=True)
                        .encode(
                            x=alt.X("run_at:T", title="Run timestamp"),
                            y=alt.Y(f"{metric}:Q", title=metric),
                            color=alt.Color("label:N", title="Label"),
                            tooltip=["run_at", "label", metric],
                        )
                        .properties(height=400)
                        .interactive()
                    )
                    st.altair_chart(line_chart, use_container_width=True)
                else:
                    st.info("No data for the selected labels.")

            # Summary table: most recent run per label
            st.divider()
            st.subheader("Latest run per label")
            latest = (
                history.sort_values("run_at", ascending=False)
                .groupby("label")
                .first()
                .reset_index()
                [["label", "run_at", "n_candles", "hit_rate_follow_prev", "strategy_expectancy"]]
                .sort_values("strategy_expectancy", ascending=False)
            )
            st.dataframe(
                latest,
                use_container_width=True,
                hide_index=True,
                column_config={
                    "hit_rate_follow_prev": st.column_config.NumberColumn("Hit Rate", format="%.1f%%"),
                    "strategy_expectancy": st.column_config.NumberColumn("Expectancy", format="%.4f"),
                    "run_at": st.column_config.DatetimeColumn("Last Run", format="MMM D, YYYY"),
                    "n_candles": st.column_config.NumberColumn("N"),
                },
            )
