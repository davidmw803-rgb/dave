"""Test statistics: clustered p-values, split halves, deflated Sharpe (§8.1, §8.6)."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats as sps

EULER_GAMMA = 0.5772156649015329


def clustered_mean_test(ar: np.ndarray, dates: np.ndarray, issuers: np.ndarray) -> tuple[float, float, float]:
    """Mean of ``ar`` with two-way (date x issuer) clustered SE. Returns (mean, se, two-sided p).

    Falls back to one-way clustering when either dimension has a single cluster.
    """
    ar = np.asarray(ar, float)
    n = len(ar)
    if n < 3:
        return (float(ar.mean()) if n else math.nan), math.nan, math.nan
    g_date = pd.factorize(pd.Series(dates))[0]
    g_iss = pd.factorize(pd.Series(issuers))[0]
    X = np.ones((n, 1))
    n_d, n_i = len(np.unique(g_date)), len(np.unique(g_iss))
    if n_d > 1 and n_i > 1:
        groups = np.column_stack([g_date, g_iss])
    elif n_d > 1:
        groups = g_date
    elif n_i > 1:
        groups = g_iss
    else:
        return float(ar.mean()), math.nan, math.nan
    res = sm.OLS(ar, X).fit(cov_type="cluster", cov_kwds={"groups": groups})
    se = float(res.bse[0])
    if not math.isfinite(se) or se <= 0:
        return float(ar.mean()), se, math.nan
    # Normal reference: the t reference with few clusters is handled by the n/dates minimums.
    p = float(2 * sps.norm.sf(abs(res.params[0] / se)))
    return float(res.params[0]), se, p


def sharpe(ar: np.ndarray) -> float:
    """Per-trade Sharpe (mean / std). Not annualized: trials are compared like for like."""
    ar = np.asarray(ar, float)
    if len(ar) < 2 or ar.std(ddof=1) == 0:
        return math.nan
    return float(ar.mean() / ar.std(ddof=1))


def expected_max_sharpe(n_trials: int, var_sr: float) -> float:
    """E[max SR] of ``n_trials`` independent zero-edge trials (Bailey & Lopez de Prado 2014)."""
    if n_trials < 2 or var_sr <= 0:
        return 0.0
    z1 = sps.norm.ppf(1 - 1 / n_trials)
    z2 = sps.norm.ppf(1 - 1 / (n_trials * math.e))
    return math.sqrt(var_sr) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def deflated_sharpe(ar: np.ndarray, n_trials: int, trial_sharpes: np.ndarray | None = None) -> tuple[float, float]:
    """Returns (SR - SR0, probability SR > SR0 adjusted for skew/kurtosis).

    SR0 is the Sharpe the best of ``n_trials`` null strategies would show. The
    cross-trial variance of SR comes from past tests when there are enough of
    them, else from the sampling variance of SR under the null (1/T).
    """
    ar = np.asarray(ar, float)
    T = len(ar)
    sr = sharpe(ar)
    if not math.isfinite(sr) or T < 3:
        return math.nan, math.nan
    if trial_sharpes is not None and np.isfinite(trial_sharpes).sum() >= 10:
        var_sr = float(np.nanvar(trial_sharpes, ddof=1))
    else:
        var_sr = 1.0 / T
    sr0 = expected_max_sharpe(n_trials, var_sr)
    skew = float(sps.skew(ar))
    kurt = float(sps.kurtosis(ar, fisher=False))
    denom = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
    prob = float(sps.norm.cdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(denom))) if denom > 0 else math.nan
    return sr - sr0, prob


def split_halves(dates: np.ndarray) -> np.ndarray:
    """Boolean mask: True for the first half of the in-sample period by event date."""
    d = np.asarray(dates, "datetime64[D]")
    uniq = np.unique(d)
    cut = uniq[len(uniq) // 2] if len(uniq) else None
    return d < cut if cut is not None else np.zeros(len(d), bool)
